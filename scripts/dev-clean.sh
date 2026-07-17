#!/usr/bin/env bash
# Kill orphaned Tildone dev processes a finished session left behind:
# dev app binaries (target/debug/tildone), tauri-CLI dev runners, and the
# vite dev server on 1420. Dev agent ports are OS-assigned and die with
# their process, so killing the processes is the whole cleanup.
#
# The installed app (/Applications/Tildone.app, port 11502) is never
# touched: nothing here matches by that port, and any pid whose command
# points into Tildone.app is skipped.
set -uo pipefail

killed=0

kill_pid() {
  local pid=$1 why=$2 cmd
  cmd=$(ps -o command= -p "$pid" 2>/dev/null) || return 0
  case "$cmd" in
    *Tildone.app*) return 0 ;;
  esac
  if kill "$pid" 2>/dev/null; then
    echo "killed $pid ($why): $cmd"
    killed=$((killed + 1))
  fi
}

for pid in $(pgrep -f 'target/debug/tildone' 2>/dev/null); do
  kill_pid "$pid" "dev app binary"
done

for pid in $(pgrep -f 'tildone/node_modules/\.bin/tauri' 2>/dev/null); do
  kill_pid "$pid" "tauri dev CLI"
done

for pid in $(lsof -ti :1420 2>/dev/null); do
  kill_pid "$pid" "vite dev server (port 1420)"
done

if [ "$killed" -eq 0 ]; then
  echo "no orphaned dev processes found"
else
  sleep 2
  for pid in $(pgrep -f 'target/debug/tildone' 2>/dev/null); do
    kill -9 "$pid" 2>/dev/null && echo "force-killed straggler $pid"
  done
fi
