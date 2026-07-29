#!/usr/bin/env bash
# Build the debug binary that `bun run e2e` drives.
#
# Everything here exists so two sessions can run e2e at the same time without
# corrupting each other (TIL-140) and so a run can never silently exercise
# someone else's code (TIL-147):
#
#   identifier  com.tildone.e2e.<slug>  — per-worktree data dir, so a parallel
#               run's onPrepare wipe cannot delete the board this run is using
#   target dir  src-tauri/target-e2e    — per-worktree binary. The identifier is
#               compiled in, so a shared target/debug/tildone would hand every
#               worktree whoever built last; isolation has to include the binary
#               or it isn't isolation. Costs one cold build per worktree.
#   touch       lib.rs                  — a frontend-only change leaves cargo
#               with no reason to relink, so the binary keeps embedding the
#               previous dist/ (TIL-110). Force the relink every time.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd -P)
slug=$(./scripts/worktree-slug.sh)

# A temp *directory* with a fixed filename inside: `$(mktemp …).json` created
# one file and then wrote a second one beside it, leaking both (TIL-150).
tmpdir=$(mktemp -d -t tildone-e2e)
trap 'rm -rf "$tmpdir"' EXIT
overlay="$tmpdir/e2e.conf.json"
cat > "$overlay" <<EOF
{
  "\$schema": "https://schema.tauri.app/config/2",
  "identifier": "com.tildone.e2e.$slug",
  "app": {
    "withGlobalTauri": true,
    "security": { "capabilities": ["default", "wdio"] }
  }
}
EOF

# Keep the frontend and the binary in lockstep: build dist/ first, then force
# the relink that embeds it.
export CARGO_TARGET_DIR="$root/src-tauri/target-e2e"
touch src-tauri/src/lib.rs

echo "tildone e2e [$slug]: identifier com.tildone.e2e.$slug, target $CARGO_TARGET_DIR"
VITE_E2E=1 ./node_modules/.bin/tauri build --debug --no-bundle --config "$overlay" "$@"

# Record the index.html that was just embedded, beside the binary it went into.
#
# wdio.conf.ts's stale-frontend check compares what the running app serves
# against this copy rather than against dist/, because dist/ does not stay put:
# this build writes it with VITE_E2E=1, and a later plain `bun run build`
# rewrites it with a different hash for identical source. The VERIFY ladder says
# "build clean, then run e2e", so that ordering is normal — and it used to make
# the guard throw about a binary that was perfectly fine (TIL-196). The copy
# belongs to the binary and changes only when the binary does.
cp dist/index.html "$CARGO_TARGET_DIR/.e2e-index.html"

# Stamp it with the time the build STARTED, not the time the copy finished.
# wdio's staleness check asks "is any watched source newer than this?", and a
# file edited while cargo was running is not in the binary — but it is older
# than the copy, so an end-of-build timestamp would call that build current.
#
# lib.rs is the reference because the touch above set it to the build's start
# instant, exactly: reformatting the clock through `date`/`touch -t` truncates
# to whole seconds, and that alone made lib.rs read as newer than its own build.
touch -r src-tauri/src/lib.rs "$CARGO_TARGET_DIR/.e2e-index.html"
