#!/usr/bin/env bash
# Print the slug identifying this worktree ("main" for the primary checkout).
#
# Single source of truth: scripts/tauri.sh derives the dev identifier from it,
# scripts/e2e-build.sh the e2e identifier, and wdio.conf.ts shells out to it so
# the test harness and the binary it runs can never disagree about which
# worktree they belong to.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd -P)

case "$root" in
  */.claude/worktrees/*) slug=$(basename "$root") ;;
  *) slug=main ;;
esac
slug=$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')
slug=${slug#-}; slug=${slug%-}
[ -n "$slug" ] || slug=main

printf '%s\n' "$slug"
