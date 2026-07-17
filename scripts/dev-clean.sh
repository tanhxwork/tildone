#!/usr/bin/env bash
# Kill Tildone dev processes.
#
#   dev:clean          only this worktree's instance — vite/tauri CLI by
#                      path, app binaries by process cwd — so parallel
#                      sessions never kill each other's runs
#   dev:clean --all    every dev instance from any checkout (orphan sweep)
#
# Dev agent ports are OS-assigned and die with their process, so killing
# the processes is the whole cleanup. The installed app
# (/Applications/Tildone.app, port 11502) is never touched: nothing here
# matches by that port, and any pid whose command points into Tildone.app
# is skipped.
set -uo pipefail
cd "$(dirname "$0")/.."
root=$(pwd -P)

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

if [ "${1:-}" = "--all" ]; then
  for pid in $(pgrep -f 'target/debug/tildone' 2>/dev/null); do
    kill_pid "$pid" "dev app binary"
  done
  for pid in $(pgrep -f 'tildone/node_modules/\.bin/tauri' 2>/dev/null); do
    kill_pid "$pid" "tauri dev CLI"
  done
  for pid in $(pgrep -f 'tildone/node_modules/\.bin/vite' 2>/dev/null); do
    kill_pid "$pid" "vite dev server"
  done
else
  for pid in $(pgrep -f "$root/node_modules/.bin/vite" 2>/dev/null); do
    kill_pid "$pid" "vite dev server ($root)"
  done
  for pid in $(pgrep -f "$root/node_modules/.bin/tauri" 2>/dev/null); do
    kill_pid "$pid" "tauri dev CLI ($root)"
  done
  # App binaries always run as `target/debug/tildone` with cwd inside their
  # worktree — the cwd is the only thing that says which worktree owns them.
  for pid in $(pgrep -f 'target/debug/tildone' 2>/dev/null); do
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    case "$cwd" in
      "$root" | "$root"/*) kill_pid "$pid" "dev app binary (this worktree)" ;;
    esac
  done
fi

if [ "$killed" -eq 0 ]; then
  echo "no matching dev processes found"
else
  sleep 2
  for pid in $(pgrep -f 'target/debug/tildone' 2>/dev/null); do
    if [ "${1:-}" != "--all" ]; then
      cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
      case "$cwd" in
        "$root" | "$root"/*) ;;
        *) continue ;;
      esac
    fi
    kill -9 "$pid" 2>/dev/null && echo "force-killed straggler $pid"
  done
fi
