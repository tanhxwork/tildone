#!/usr/bin/env bash
# scripts/self-update.sh parses, and a dry run prints every stage in order and
# runs none of them (TIL-248).
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd -P)
script="$repo_root/scripts/self-update.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

bash -n "$script" || fail "scripts/self-update.sh does not parse"

# Stub tools, so the check for git, bun and cargo passes on any machine.
scratch=$(mktemp -d "${TMPDIR:-/tmp}/tildone-self-update.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin" "$scratch/home"
for tool in git bun cargo; do
  printf '#!/bin/sh\n' > "$scratch/bin/$tool"
  chmod +x "$scratch/bin/$tool"
done

out=$(PATH="$scratch/bin:$PATH" CARGO_TARGET_DIR=/nonexistent/target "$script" 99999999 /usr/bin/tildone --dry-run) ||
  fail "the dry run exited nonzero"

# Each stage once, in order.
prev=0
for stage in "pull" "install dependencies" "build the release bundle" "install" "stop the app" "relaunch" "update: done"; do
  line=$(printf '%s\n' "$out" | grep -n -m1 -E "^[^ ]+ $stage( \\(|$)" | cut -d: -f1 || true)
  [[ -n "$line" ]] || fail "dry run did not print the '$stage' stage: $out"
  ((line > prev)) || fail "stage '$stage' is out of order: $out"
  prev=$line
done

printf '%s\n' "$out" | grep -qF "bun install --frozen-lockfile" || fail "bun install is not frozen: $out"
printf '%s\n' "$out" | grep -qF "git pull --ff-only origin main" || fail "no ff-only pull: $out"
printf '%s\n' "$out" | grep -qF "tauri build --bundles" || fail "no bundle build: $out"
printf '%s\n' "$out" | grep -qF "/nonexistent/target/release/bundle" || fail "CARGO_TARGET_DIR not used: $out"

# A missing tool stops it early, naming the tool.
rm "$scratch/bin/bun"
if out=$(HOME="$scratch/home" PATH="$scratch/bin:/usr/bin:/bin" "$script" 99999999 /usr/bin/tildone --dry-run 2>&1); then
  fail "ran without bun: $out"
fi
printf '%s\n' "$out" | grep -qE "cannot find bun on PATH" || fail "the missing tool is not named: $out"

if "$script" 2>/dev/null; then fail "ran without the pid and exe arguments"; fi

echo "PASS self-update: parses, and a dry run prints every stage"
