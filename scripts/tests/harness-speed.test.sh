#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd -P)
mode=${1:-all}
scratch=$(mktemp -d -t tildone-harness-speed)
trap 'rm -rf "$scratch"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local want=$1 got=$2 label=$3
  [[ "$got" == "$want" ]] || fail "$label — wanted '$want', got '$got'"
}

write_fake_bun() {
  local bin_dir=$1
  mkdir -p "$bin_dir"
  cat > "$bin_dir/bun" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--version" ]]; then
  echo "${FAKE_BUN_VERSION:-1.4.0}"
  exit 0
fi

if [[ "${1:-}" == "run" && "${2:-}" == "build" ]]; then
  before=$(scripts/record-build-green.sh begin 2>/dev/null || true)
  count=$(cat "$HARNESS_BUILD_COUNT" 2>/dev/null || echo 0)
  echo $((count + 1)) > "$HARNESS_BUILD_COUNT"
  [[ ! -f .fail-build ]] || exit 1
  mkdir -p dist
  printf '<!doctype html>\n' > dist/index.html
  if [[ -f .mutate-during-build ]]; then
    printf 'export const value = changedDuringBuild;\n' > src/value.ts
  fi
  if [[ -x scripts/record-build-green.sh ]]; then
    scripts/record-build-green.sh finish "$before"
  fi
  exit 0
fi

echo "unexpected fake bun invocation: $*" >&2
exit 64
SH
  chmod +x "$bin_dir/bun"
}

write_fake_e2e_toolchain() {
  local fixture=$1
  mkdir -p "$fixture/bin" "$fixture/node_modules/.bin"

  cat > "$fixture/bin/bun" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "${FAKE_BUN_VERSION:-1.4.0}"
  exit 0
fi
exit 64
SH

  cat > "$fixture/bin/rustc" <<'SH'
#!/usr/bin/env bash
echo "rustc ${FAKE_RUST_VERSION:-1.90.0}"
SH

  cat > "$fixture/bin/cargo" <<'SH'
#!/usr/bin/env bash
echo "cargo ${FAKE_CARGO_VERSION:-1.90.0}"
SH

  cat > "$fixture/node_modules/.bin/tauri" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--version" ]]; then
  echo "tauri-cli ${FAKE_TAURI_VERSION:-2.11.4}"
  exit 0
fi

if [[ "${1:-}" == "build" ]]; then
  count=$(cat "$HARNESS_E2E_COUNT" 2>/dev/null || echo 0)
  echo $((count + 1)) > "$HARNESS_E2E_COUNT"
  [[ ! -f .fail-e2e ]] || exit 1
  mkdir -p "$CARGO_TARGET_DIR/debug" dist
  printf '#!/usr/bin/env bash\nexit 0\n' > "$CARGO_TARGET_DIR/debug/tildone"
  chmod +x "$CARGO_TARGET_DIR/debug/tildone"
  printf '<script type="module" src="/assets/index-fixture.js"></script>\n' > dist/index.html
  exit 0
fi

echo "unexpected fake tauri invocation: $*" >&2
exit 64
SH

  chmod +x "$fixture/bin/bun" "$fixture/bin/rustc" "$fixture/bin/cargo" \
    "$fixture/node_modules/.bin/tauri"
}

setup_build_fixture() {
  local fixture=$1
  mkdir -p "$fixture/src" "$fixture/public" "$fixture/node_modules" \
    "$fixture/.claude/hooks" "$fixture/.claude/session-state" "$fixture/scripts"
  cp "$repo_root/.claude/hooks/stop-build-gate.sh" "$fixture/.claude/hooks/"
  [[ ! -f "$repo_root/scripts/input-fingerprint.sh" ]] \
    || cp "$repo_root/scripts/input-fingerprint.sh" "$fixture/scripts/"
  [[ ! -f "$repo_root/scripts/record-build-green.sh" ]] \
    || cp "$repo_root/scripts/record-build-green.sh" "$fixture/scripts/"
  chmod +x "$fixture/.claude/hooks/stop-build-gate.sh"
  chmod +x "$fixture/scripts/"*.sh 2>/dev/null || true

  printf 'export const value = 1;\n' > "$fixture/src/value.ts"
  printf '<div id="root"></div>\n' > "$fixture/index.html"
  printf '{"scripts":{"build":"fake"}}\n' > "$fixture/package.json"
  printf 'lock\n' > "$fixture/bun.lock"
  printf '{}\n' > "$fixture/tsconfig.json"
  printf 'export default {}\n' > "$fixture/vite.config.ts"
  printf '.env*\n' > "$fixture/.gitignore"

  git -C "$fixture" init -q -b main
  git -C "$fixture" config user.email harness-test@example.invalid
  git -C "$fixture" config user.name 'Harness Test'
  git -C "$fixture" add .
  git -C "$fixture" commit -qm baseline
  printf 'export const value = 2;\n' > "$fixture/src/value.ts"
}

run_stop_hook() {
  local fixture=$1 count_file=$2
  local payload
  payload=$(printf '{"cwd":"%s","session_id":"harness-test"}' "$fixture")
  PATH="$fixture/bin:$PATH" \
    HARNESS_BUILD_COUNT="$count_file" \
    CLAUDE_PROJECT_DIR="$fixture" \
    bash "$fixture/.claude/hooks/stop-build-gate.sh" <<< "$payload"
}

test_build_cache() {
  local fixture="$scratch/build" count_file="$scratch/build-count"
  setup_build_fixture "$fixture"
  write_fake_bun "$fixture/bin"
  echo 0 > "$count_file"

  run_stop_hook "$fixture" "$count_file"
  run_stop_hook "$fixture" "$count_file"
  assert_eq 1 "$(cat "$count_file")" \
    'unchanged second Stop reuses the green build receipt'

  ordinary_receipt=$(cat "$fixture/dist/.tildone-build-fingerprint")
  e2e_before=$(VITE_E2E=1 PATH="$fixture/bin:$PATH" \
    "$fixture/scripts/record-build-green.sh" begin)
  VITE_E2E=1 PATH="$fixture/bin:$PATH" \
    "$fixture/scripts/record-build-green.sh" finish "$e2e_before"
  assert_eq "$ordinary_receipt" "$(cat "$fixture/dist/.tildone-build-fingerprint")" \
    'an e2e-mode build leaves ordinary build evidence untouched'
  run_stop_hook "$fixture" "$count_file"
  assert_eq 1 "$(cat "$count_file")" \
    'ordinary evidence remains reusable after an unchanged e2e build'

  rm "$fixture/dist/.tildone-build-fingerprint"
  e2e_before=$(VITE_E2E=1 PATH="$fixture/bin:$PATH" \
    "$fixture/scripts/record-build-green.sh" begin)
  VITE_E2E=1 PATH="$fixture/bin:$PATH" \
    "$fixture/scripts/record-build-green.sh" finish "$e2e_before"
  [[ ! -e "$fixture/dist/.tildone-build-fingerprint" ]] \
    || fail 'an e2e-mode build must not create ordinary build evidence'
  run_stop_hook "$fixture" "$count_file"
  assert_eq 2 "$(cat "$count_file")" \
    'missing ordinary evidence still runs the full build'

  printf 'export const value = 3;\n' > "$fixture/src/value.ts"
  run_stop_hook "$fixture" "$count_file"
  assert_eq 3 "$(cat "$count_file")" 'a content edit invalidates the receipt'
  git -C "$fixture" add src/value.ts
  git -C "$fixture" commit -qm 'accept current source state'

  printf 'VITE_FIXTURE=changed\n' > "$fixture/.env.local"
  run_stop_hook "$fixture" "$count_file"
  assert_eq 4 "$(cat "$count_file")" 'an ignored Vite env file invalidates the receipt'

  printf 'changed lock\n' > "$fixture/bun.lock"
  run_stop_hook "$fixture" "$count_file"
  assert_eq 5 "$(cat "$count_file")" 'a lockfile edit reaches the Stop build gate'

  printf 'export const value = 4;\n' > "$fixture/src/value.ts"
  touch "$fixture/.mutate-during-build"
  run_stop_hook "$fixture" "$count_file"
  rm "$fixture/.mutate-during-build"
  run_stop_hook "$fixture" "$count_file"
  assert_eq 7 "$(cat "$count_file")" \
    'an edit racing a successful build is not recorded as green'

  printf 'export const value = broken;\n' > "$fixture/src/value.ts"
  touch "$fixture/.fail-build"
  set +e
  run_stop_hook "$fixture" "$count_file" >/dev/null 2>&1
  first_status=$?
  run_stop_hook "$fixture" "$count_file" >/dev/null 2>&1
  second_status=$?
  set -e
  assert_eq 2 "$first_status" 'a failed build blocks Stop'
  assert_eq 2 "$second_status" 'a failed state is never reused as green'
  assert_eq 9 "$(cat "$count_file")" 'each failed Stop reruns the build'

  echo 'PASS build: exact green state reused; edits and failures rebuild'
}

setup_e2e_fixture() {
  local fixture=$1
  mkdir -p "$fixture/scripts" "$fixture/src" "$fixture/public" \
    "$fixture/src-tauri/src" "$fixture/src-tauri/migrations" \
    "$fixture/src-tauri/capabilities"
  cp "$repo_root/scripts/e2e-build.sh" "$fixture/scripts/"
  cp "$repo_root/scripts/worktree-slug.sh" "$fixture/scripts/"
  [[ ! -f "$repo_root/scripts/input-fingerprint.sh" ]] \
    || cp "$repo_root/scripts/input-fingerprint.sh" "$fixture/scripts/"
  chmod +x "$fixture/scripts/"*.sh

  printf 'export const app = 1;\n' > "$fixture/src/App.tsx"
  printf 'public\n' > "$fixture/public/fixture.txt"
  printf '<div id="root"></div>\n' > "$fixture/index.html"
  printf '{"scripts":{}}\n' > "$fixture/package.json"
  printf 'lock\n' > "$fixture/bun.lock"
  printf '{}\n' > "$fixture/tsconfig.json"
  printf 'export default {}\n' > "$fixture/vite.config.ts"
  printf 'pub fn run() {}\n' > "$fixture/src-tauri/src/lib.rs"
  printf 'fn main() {}\n' > "$fixture/src-tauri/build.rs"
  printf '[package]\nname="fixture"\nversion="0.1.0"\n' > "$fixture/src-tauri/Cargo.toml"
  printf 'lock\n' > "$fixture/src-tauri/Cargo.lock"
  printf '{}\n' > "$fixture/src-tauri/tauri.conf.json"
  printf '{}\n' > "$fixture/src-tauri/capabilities/default.json"
  printf 'SELECT 1;\n' > "$fixture/src-tauri/migrations/001.sql"
  printf 'dist/\nsrc-tauri/target-e2e/\nnode_modules/\nbin/\n' > "$fixture/.gitignore"

  git -C "$fixture" init -q -b main
  git -C "$fixture" config user.email harness-test@example.invalid
  git -C "$fixture" config user.name 'Harness Test'
  git -C "$fixture" add .
  git -C "$fixture" commit -qm baseline
}

run_e2e_build() {
  local fixture=$1 count_file=$2
  shift 2
  PATH="$fixture/bin:$PATH" \
    HARNESS_E2E_COUNT="$count_file" \
    "$fixture/scripts/e2e-build.sh" "$@"
}

test_e2e_cache() {
  local fixture="$scratch/e2e" count_file="$scratch/e2e-count"
  setup_e2e_fixture "$fixture"
  write_fake_e2e_toolchain "$fixture"
  echo 0 > "$count_file"

  run_e2e_build "$fixture" "$count_file" >/dev/null
  run_e2e_build "$fixture" "$count_file" >/dev/null
  assert_eq 1 "$(cat "$count_file")" \
    'unchanged second e2e build reuses the private binary'

  printf '# damaged\n' >> "$fixture/src-tauri/target-e2e/debug/tildone"
  run_e2e_build "$fixture" "$count_file" >/dev/null
  assert_eq 2 "$(cat "$count_file")" 'a modified private binary cannot be reused'

  printf '<script src="/assets/damaged.js"></script>\n' \
    > "$fixture/src-tauri/target-e2e/.e2e-index.html"
  run_e2e_build "$fixture" "$count_file" >/dev/null
  assert_eq 3 "$(cat "$count_file")" 'a modified embedded-index sidecar cannot be reused'

  touch "$fixture/src/App.tsx"
  run_e2e_build "$fixture" "$count_file" >/dev/null
  assert_eq 3 "$(cat "$count_file")" 'mtime-only source changes reuse by content'
  [[ ! "$fixture/src/App.tsx" -nt "$fixture/src-tauri/target-e2e/.e2e-index.html" ]] \
    || fail 'cache hit leaves no watched source newer than the refreshed sidecar'

  printf 'export const app = 2;\n' > "$fixture/src/App.tsx"
  run_e2e_build "$fixture" "$count_file" >/dev/null
  assert_eq 4 "$(cat "$count_file")" 'embedded source content invalidates e2e'

  printf '{"permissions":["changed"]}\n' > "$fixture/src-tauri/capabilities/default.json"
  run_e2e_build "$fixture" "$count_file" >/dev/null
  assert_eq 5 "$(cat "$count_file")" 'Tauri capability content invalidates e2e'

  FAKE_RUST_VERSION=1.91.0 run_e2e_build "$fixture" "$count_file" >/dev/null
  assert_eq 6 "$(cat "$count_file")" 'Rust toolchain version invalidates e2e'

  FAKE_RUST_VERSION=1.91.0 run_e2e_build "$fixture" "$count_file" --features alternate >/dev/null
  assert_eq 7 "$(cat "$count_file")" 'build arguments invalidate e2e'

  echo 'PASS e2e: exact private binary reused; content, tools and args rebuild'
}

case "$mode" in
  build) test_build_cache ;;
  e2e) test_e2e_cache ;;
  all)
    test_build_cache
    test_e2e_cache
    ;;
  *) fail "unknown mode: $mode" ;;
esac
