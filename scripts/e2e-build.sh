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
