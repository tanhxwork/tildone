#!/usr/bin/env bash
# Print the slug identifying this worktree ("main" for the primary checkout).
#
# Single source of truth: scripts/tauri.sh derives the dev identifier from it,
# scripts/e2e-build.sh the e2e identifier, and wdio.conf.ts shells out to it so
# the test harness and the binary it runs can never disagree about which
# worktree they belong to.
#
# "Primary" is decided by git, not by path. Keying on the path containing
# .claude/worktrees meant a worktree created anywhere else collapsed to "main"
# and silently shared the primary checkout's identifier — and so its dev
# database and its e2e data dir (TIL-150).
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd -P)

# A linked worktree has its own git dir under the common dir's worktrees/;
# for the primary checkout the two resolve to the same path.
gitdir=$(git -C "$root" rev-parse --absolute-git-dir 2>/dev/null || true)
common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)

if [ -n "$gitdir" ] && [ -n "$common" ] && [ "$gitdir" != "$common" ]; then
  slug=$(basename "$root")
else
  slug=main
fi

slug=$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')
slug=$(printf '%s' "$slug" | sed -e 's/^-*//' -e 's/-*$//')
[ -n "$slug" ] || slug=main

# The slug becomes a bundle identifier, a directory name and part of a mktemp
# template, so an unbounded one fails with "File name too long". Truncate and
# append a hash of the full path, which also disambiguates two long names that
# would otherwise sanitize to the same prefix.
if [ "${#slug}" -gt 40 ]; then
  slug="$(printf '%s' "$slug" | cut -c1-33)-$(printf '%s' "$root" | cksum | cut -d' ' -f1 | cut -c1-6)"
fi

printf '%s\n' "$slug"
