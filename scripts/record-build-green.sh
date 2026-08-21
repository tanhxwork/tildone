#!/usr/bin/env bash
# Record successful build evidence for stop-build-gate.sh. `begin` captures
# the exact state before lint/typecheck/bundle and clears old evidence;
# `finish` writes only when that state is still exact after the build.
# Recording is an optimization only: a failure here must never turn a green
# build red.
set -uo pipefail

root=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd -P) || exit 0
receipt="$root/dist/.tildone-build-fingerprint"
command=${1:-}

# The Tauri e2e build sets VITE_E2E=1 around its beforeBuildCommand. It owns a
# separate binary receipt and must neither clear nor create ordinary evidence.
[[ "${VITE_E2E:-0}" == "1" ]] && exit 0

case "$command" in
  begin)
    mkdir -p "$root/dist" 2>/dev/null || exit 0
    rm -f "$receipt" 2>/dev/null || true
    fingerprint=$("$root/scripts/input-fingerprint.sh" build 2>/dev/null) || exit 0
    [[ "$fingerprint" =~ ^[0-9a-f]{40,64}$ ]] || exit 0
    printf '%s\n' "$fingerprint"
    ;;
  finish)
    before=${2:-}
    [[ "$before" =~ ^[0-9a-f]{40,64}$ ]] || exit 0
    after=$("$root/scripts/input-fingerprint.sh" build 2>/dev/null) || exit 0
    [[ "$after" == "$before" ]] || exit 0
    mkdir -p "$root/dist" 2>/dev/null || exit 0
    printf '%s\n' "$before" > "$receipt" 2>/dev/null || true
    ;;
esac
exit 0
