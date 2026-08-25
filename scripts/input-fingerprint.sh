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

# One `git hash-object` for every regular file, not one per file. The per-file
# form cost ~100 spawns and ~900 ms per Stop (measured 2026-08-25 against a
# 12 MB transcript: stop-build-gate 897 ms / 107 git, all of it here). The
# record stream is byte-identical to the per-file version — same order, same
# blob ids — so an existing receipt stays valid across this change.
#
# `--stdin-paths` is newline-separated (this git has no `-z` for it), so a path
# containing a newline is hashed on its own. bash 3.2 (macOS /bin/bash): no
# mapfile, and `-u` rejects an empty "${arr[@]}", hence the count guards.
emit_path_records() {
  local paths=() files=() hashes=() p h i=0
  while IFS= read -r -d '' p; do paths+=("$p"); done
  [[ ${#paths[@]} -gt 0 ]] || return 0
  for p in "${paths[@]}"; do
    [[ ! -L "$p" && -f "$p" && "$p" != *$'\n'* ]] && files+=("$p")
  done
  if [[ ${#files[@]} -gt 0 ]]; then
    while IFS= read -r h; do hashes+=("$h"); done \
      < <(printf '%s\n' "${files[@]}" | git hash-object --stdin-paths)
    # A short answer means git failed on some path; a fingerprint that silently
    # skipped a file would let a stale receipt pass the build gate.
    [[ ${#hashes[@]} -eq ${#files[@]} ]] || return 1
  fi
  for p in "${paths[@]}"; do
    printf 'path\0%s\0' "$p"
    if [[ -L "$p" ]]; then
      printf 'symlink\0%s\0' "$(readlink "$p")"
    elif [[ -f "$p" ]]; then
      if [[ "$p" == *$'\n'* ]]; then
        h=$(git hash-object "$p")
      else
        h=${hashes[$i]}
        i=$((i + 1))
      fi
      printf 'blob\0%s\0' "$h"
    else
      printf 'missing\0'
    fi
  done
}

# The record stream lands in a temp file and is hashed only once every stage
# succeeded: a stage failing mid-stream used to leave a truncated stream on
# stdout, which the callers' `|| true` then read as a real fingerprint.
stream=$(mktemp) || exit 1
trap 'rm -f "$stream"' EXIT

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
  {
    for path in .env .env.*; do
      [[ -e "$path" || -L "$path" ]] || continue
      printf '%s\0' "$path"
    done
    git ls-files -co --exclude-standard -z -- "${pathspecs[@]}"
  } | emit_path_records
} > "$stream"
git hash-object --stdin < "$stream"
