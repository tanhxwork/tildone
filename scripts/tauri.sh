#!/usr/bin/env bash
# Entry point for `bun run tauri <subcommand>`.
#
# `dev` runs an isolated per-worktree instance (spec:
# docs/specs/2026-07-17-per-worktree-dev-isolation.md): its own name
# ("Tildone Dev — <slug>"), identifier and database (com.tildone.dev.<slug>),
# vite port, and icon tint, so parallel agent sessions never collide with
# each other or with the installed app. Every other subcommand passes
# through untouched — release bundles keep the real name, identifier and
# icons.
#
# TILDONE_DEV_DB=fresh          start with an empty database instead of a
#                               copy of the installed app's data
# TILDONE_DEV_PRINT_CONFIG=1    print the generated overlay and exit before
#                               launching (used by tests and for debugging)
set -euo pipefail
cd "$(dirname "$0")/.."
tauri=./node_modules/.bin/tauri

[ "${1:-}" = "dev" ] || exec "$tauri" "$@"
shift

root=$(pwd -P)

# --- slug: which worktree is this? ---------------------------------------
case "$root" in
  */.claude/worktrees/*) slug=$(basename "$root") ;;
  *) slug=main ;;
esac
slug=$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')
slug=${slug#-}; slug=${slug%-}
[ -n "$slug" ] || slug=main

# --- port: first free one from 1420 up ------------------------------------
port=1420
while nc -z 127.0.0.1 "$port" >/dev/null 2>&1; do port=$((port + 1)); done
export TILDONE_DEV_PORT=$port

# --- database: seed from the installed app on first run -------------------
# sqlite3 .backup takes a consistent snapshot even while the installed app
# is running (WAL); the source is only ever read.
devdir="$HOME/Library/Application Support/com.tildone.dev.$slug"
srcdb="$HOME/Library/Application Support/com.tildone.desktop/tildone.db"
if [ ! -e "$devdir/tildone.db" ] && [ "${TILDONE_DEV_DB:-copy}" != "fresh" ] && [ -e "$srcdb" ]; then
  mkdir -p "$devdir"
  if sqlite3 "$srcdb" ".backup '$devdir/tildone.db'" 2>/dev/null; then
    echo "tildone dev [$slug]: database seeded from the installed app"
  else
    rm -f "$devdir/tildone.db"
    echo "tildone dev [$slug]: could not snapshot the installed DB — starting empty"
  fi
fi

# --- icons: per-worktree hue, silent fallback to the committed red set ----
# Hue is derived from the slug; the band around the production purple
# (247°) is skipped so no dev instance can be mistaken for the installed
# app. Generated PNGs are forced RGBA (PNG32:) — tauri's codegen rejects
# palette PNGs.
icons="icons-dev"
if command -v magick >/dev/null 2>&1; then
  gen="src-tauri/icons-dev/$slug"
  if [ ! -e "$gen/32x32.png" ]; then
    hash=$(printf '%s' "$slug" | cksum | cut -d' ' -f1)
    hue=$((hash % 360))
    if [ "$hue" -ge 217 ] && [ "$hue" -le 277 ]; then hue=$(((hue + 90) % 360)); fi
    delta=$(((hue - 247 + 720) % 360))
    mod=$((100 + delta * 100 / 180))
    mkdir -p "$gen"
    ok=1
    for f in 32x32.png 128x128.png 128x128@2x.png; do
      magick "src-tauri/icons/$f" -modulate "100,100,$mod" "PNG32:$gen/$f" 2>/dev/null || { ok=0; break; }
    done
    [ "$ok" = 1 ] || rm -rf "$gen"
  fi
  [ -e "$gen/32x32.png" ] && icons="icons-dev/$slug"
fi

# --- per-run overlay -------------------------------------------------------
overlay=$(mktemp -t "tildone-dev-$slug").json
cat > "$overlay" <<EOF
{
  "\$schema": "https://schema.tauri.app/config/2",
  "productName": "Tildone Dev — $slug",
  "identifier": "com.tildone.dev.$slug",
  "build": { "devUrl": "http://localhost:$port" },
  "bundle": {
    "icon": ["$icons/32x32.png", "$icons/128x128.png", "$icons/128x128@2x.png"]
  }
}
EOF

if [ "${TILDONE_DEV_PRINT_CONFIG:-}" = "1" ]; then
  echo "slug=$slug port=$port overlay=$overlay"
  cat "$overlay"
  exit 0
fi

echo "tildone dev [$slug]: port $port, identifier com.tildone.dev.$slug"
exec "$tauri" dev --config "$overlay" "$@"
