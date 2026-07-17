#!/usr/bin/env bash
# Entry point for `bun run tauri <subcommand>`.
#
# `dev` gets the overlay in src-tauri/tauri.dev.conf.json: the app runs as
# "Tildone Dev" under the com.tildone.dev identifier, so it keeps its own
# data dir/DB and can never be mistaken for the installed app. Every other
# subcommand (build, icon, ...) passes through untouched — release bundles
# must keep the real name and identifier.
set -euo pipefail
cd "$(dirname "$0")/.."
tauri=./node_modules/.bin/tauri
if [ "${1:-}" = "dev" ]; then
  shift
  exec "$tauri" dev --config src-tauri/tauri.dev.conf.json "$@"
fi
exec "$tauri" "$@"
