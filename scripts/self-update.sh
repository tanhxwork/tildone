#!/usr/bin/env bash
# Update the running Tildone from the checkout it was built from, then relaunch it.
# Started by the client `update` action (src-tauri/src/clientactions.rs), detached,
# with its output appended to <app data>/self-update.log.
#
#   scripts/self-update.sh <app-pid> <exe-path> [--dry-run]
#
# Linux:  pull, bun install, `tauri build --bundles deb`, `sudo -n apt-get install
#         --reinstall` of that .deb (needs passwordless sudo), relaunch the binary.
# macOS:  pull, bun install, `tauri build --bundles app`, replace the running .app
#         (derived from <exe-path>) with the built one, `open` it.
# --dry-run prints each stage and command and runs none of them.
set -euo pipefail

pid=${1:?usage: self-update.sh <app-pid> <exe-path> [--dry-run]}
exe=${2:?usage: self-update.sh <app-pid> <exe-path> [--dry-run]}
dry=
[ "${3:-}" = "--dry-run" ] && dry=1

cd "$(dirname "$0")/.."
repo=$(pwd -P)
os=$(uname -s)
target=${CARGO_TARGET_DIR:-$repo/src-tauri/target}

stage() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*"; }
run() {
  stage "+ $*"
  [ -n "$dry" ] || "$@"
}

case "$os" in
  Linux) bundles=deb ;;
  Darwin) bundles=app ;;
  *)
    stage "update is not supported on $os"
    exit 1
    ;;
esac

stage "update: start (pid $pid, exe $exe, repo $repo${dry:+, dry run})"

stage "pull"
run git pull --ff-only origin main

stage "install dependencies"
run bun install

stage "build the release bundle ($bundles)"
run bun run tauri build --bundles "$bundles"

stage "install"
if [ "$os" = Linux ]; then
  # Newest .deb in the bundle dir; the glob stays literal in a dry run.
  debs=("$target"/release/bundle/deb/*.deb)
  deb=${debs[0]}
  if [ -z "$dry" ]; then
    deb=$(ls -t "$target"/release/bundle/deb/*.deb | head -n 1)
  fi
  run sudo -n apt-get install -y --reinstall "$deb"
else
  case "$exe" in
    *.app/Contents/MacOS/*) bundle=${exe%/Contents/MacOS/*} ;;
    *)
      stage "cannot find the .app of $exe"
      exit 1
      ;;
  esac
  built=$(ls -dt "$target"/release/bundle/macos/*.app 2>/dev/null | head -n 1 || true)
  if [ -n "$dry" ] && [ -z "$built" ]; then
    built="$target/release/bundle/macos/Tildone.app"
  fi
  [ -n "$built" ] || { stage "no built .app under $target/release/bundle/macos"; exit 1; }
  run ditto "$built" "$bundle.new"
  run mv "$bundle" "$bundle.old"
  run mv "$bundle.new" "$bundle"
  run rm -rf "$bundle.old"
fi

stage "stop the app (pid $pid)"
run kill "$pid"
if [ -z "$dry" ]; then
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null || true
fi

stage "relaunch"
if [ "$os" = Linux ]; then
  # The .deb replaces the binary in place; a dev build outside /usr relaunches the
  # installed one of the same name.
  case "$exe" in
    /usr/* | /opt/*) launch=$exe ;;
    *) launch=/usr/bin/$(basename "$exe") ;;
  esac
  stage "+ setsid nohup $launch"
  [ -n "$dry" ] || setsid nohup "$launch" >/dev/null 2>&1 &
else
  run open "$bundle"
fi

stage "update: done"
