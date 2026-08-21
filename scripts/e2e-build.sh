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
export CARGO_TARGET_DIR="$root/src-tauri/target-e2e"
mkdir -p "$CARGO_TARGET_DIR"
build_start="$CARGO_TARGET_DIR/.e2e-build-start"
embedded_index="$CARGO_TARGET_DIR/.e2e-index.html"
input_receipt="$CARGO_TARGET_DIR/.e2e-input-fingerprint"
artifact_receipt="$CARGO_TARGET_DIR/.e2e-artifact-fingerprint"
binary="$CARGO_TARGET_DIR/debug/tildone"

artifact_fingerprint() {
  [[ -x "$binary" && -f "$embedded_index" ]] || return 1
  printf '%s %s\n' "$(git hash-object "$binary")" "$(git hash-object "$embedded_index")"
}

# Content equality, not mtime, decides whether the private binary can be
# reused. Compute once before freezing the guard clock; a cache candidate is
# fingerprinted a second time after that clock. If anything changes between
# the two reads they differ, and anything changing after the second read is
# newer than the clock, so wdio's existing mtime guard rejects the run.
input_fingerprint=""
if [[ -x "$root/scripts/input-fingerprint.sh" ]]; then
  input_fingerprint=$("$root/scripts/input-fingerprint.sh" e2e "$@" 2>/dev/null || true)
fi
touch "$build_start"

if [[ -n "$input_fingerprint" && -x "$binary" && -f "$embedded_index" \
  && -f "$input_receipt" && -f "$artifact_receipt" ]]; then
  recorded_fingerprint=$(cat "$input_receipt" 2>/dev/null || true)
  recorded_artifact=$(cat "$artifact_receipt" 2>/dev/null || true)
  checked_artifact=$(artifact_fingerprint 2>/dev/null || true)
  checked_fingerprint=$("$root/scripts/input-fingerprint.sh" e2e "$@" 2>/dev/null || true)
  if [[ "$input_fingerprint" == "$recorded_fingerprint" \
    && "$checked_fingerprint" == "$recorded_fingerprint" \
    && -n "$checked_artifact" && "$checked_artifact" == "$recorded_artifact" ]]; then
    touch -r "$build_start" "$embedded_index"
    echo "tildone e2e [$slug]: reused exact private binary $binary"
    exit 0
  fi
fi

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
# the relink that embeds it. Empty the old receipt before the attempt, so a
# failed build or failed fingerprint can never leave reusable green evidence.
: > "$input_receipt"
: > "$artifact_receipt"
touch src-tauri/src/lib.rs

# Freeze the build's start instant in a file nothing else writes. The sidecar is
# stamped from THIS at the end, not from lib.rs directly: lib.rs is a source
# file, so an edit landing while cargo runs would move the very clock meant to
# catch it, and the sidecar would come out equal to the edit rather than older
# than it (Codex, TIL-196 round 2).
touch -r src-tauri/src/lib.rs "$build_start"

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
cp dist/index.html "$embedded_index"

built_artifact_fingerprint=$(artifact_fingerprint 2>/dev/null || true)
if [[ -n "$input_fingerprint" && -n "$built_artifact_fingerprint" ]]; then
  printf '%s\n' "$built_artifact_fingerprint" > "$artifact_receipt"
  printf '%s\n' "$input_fingerprint" > "$input_receipt"
fi

# Stamp it with the time the build STARTED, not the time the copy finished.
# wdio's staleness check asks "is any watched source newer than this?", and a
# file edited while cargo was running is not in the binary — but it is older
# than the copy, so an end-of-build timestamp would call that build current.
#
# The stamp is a copy of lib.rs's mtime taken before cargo started, so it is the
# build's start instant to the nanosecond and cannot move afterwards.
# Reformatting a clock through `date`/`touch -t` instead truncates to whole
# seconds, which alone made lib.rs read as newer than its own build.
touch -r "$build_start" "$embedded_index"
