#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
mode=${1:-}
shift || true
cd "$root"

case "$mode" in
  build)
    pathspecs=(
      src public index.html package.json bun.lock
      ':(glob)tsconfig*.json'
      ':(glob)vite.config.*'
      ':(glob).oxlintrc*'
      ':(glob)oxlint*.json'
      scripts/input-fingerprint.sh
      scripts/record-build-green.sh
    )
    ;;
  e2e)
    pathspecs=(
      src public index.html package.json bun.lock
      ':(glob)tsconfig*.json'
      ':(glob)vite.config.*'
      ':(glob).oxlintrc*'
      ':(glob)oxlint*.json'
      scripts/input-fingerprint.sh
      scripts/e2e-build.sh
      scripts/worktree-slug.sh
      src-tauri
    )
    ;;
  *)
    echo "usage: $0 build|e2e [build arguments...]" >&2
    exit 64
    ;;
esac

emit_path_record() {
  local path=$1
  printf 'path\0%s\0' "$path"
  if [[ -L "$path" ]]; then
    printf 'symlink\0%s\0' "$(readlink "$path")"
  elif [[ -f "$path" ]]; then
    printf 'blob\0%s\0' "$(git hash-object "$path")"
  else
    printf 'missing\0'
  fi
}

{
  printf 'tildone-input-fingerprint-v1\0mode\0%s\0' "$mode"
  printf 'bun\0%s\0' "$(bun --version)"
  printf 'node\0%s\0' "$(node --version)"
  printf 'build-env\0'
  env | LC_ALL=C sort | while IFS= read -r variable; do
    case "$variable" in
      NODE_ENV=*|VITE_*=*)
        if [[ "$mode" != "e2e" || "$variable" != VITE_E2E=* ]]; then
          printf '%s\0' "$variable"
        fi
        ;;
    esac
  done
  if [[ "$mode" == "e2e" ]]; then
    # e2e-build.sh forces this value only for the Tauri build command, after
    # fingerprinting. Record the effective value rather than the caller's.
    printf 'forced-env\0VITE_E2E=1\0'
    printf 'rustc\0%s\0' "$(rustc --version)"
    printf 'cargo\0%s\0' "$(cargo --version)"
    printf 'tauri\0%s\0' "$(./node_modules/.bin/tauri --version)"
    printf 'slug\0%s\0' "$(./scripts/worktree-slug.sh)"
  fi
  printf 'args\0'
  for arg in "$@"; do
    printf '%s\0' "$arg"
  done

  # Vite consumes root .env files even when they are intentionally gitignored.
  # Hash their contents without ever printing them outside this hash stream.
  for path in .env .env.*; do
    [[ -e "$path" || -L "$path" ]] || continue
    emit_path_record "$path"
  done

  git ls-files -co --exclude-standard -z -- "${pathspecs[@]}" \
    | while IFS= read -r -d '' path; do
        emit_path_record "$path"
      done
} | git hash-object --stdin
