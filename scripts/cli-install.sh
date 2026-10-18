#!/usr/bin/env bash
# Build the tildone-axi CLI for this machine and link it into ~/.local/bin.
# `bun run cli:install`. The link points at the build output, so rebuilding
# (re-running this) updates what the link runs.
set -eu
cd "$(dirname "$0")/.."

cargo build --release --manifest-path cli/Cargo.toml
bin="${CARGO_TARGET_DIR:-$(pwd -P)/cli/target}/release/tildone-axi"
[ -f "$bin" ] || { echo "cli-install: built binary not found at $bin" >&2; exit 1; }

dir="$HOME/.local/bin"
link="$dir/tildone-axi"
mkdir -p "$dir"
if [ -e "$link" ] && [ ! -L "$link" ]; then
  echo "cli-install: $link exists and is not a symlink; leaving it alone" >&2
  exit 1
fi
ln -sfn "$bin" "$link"
echo "linked $link -> $bin"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "hint: $dir is not on your PATH; add 'export PATH=\"\$HOME/.local/bin:\$PATH\"' to your shell profile" ;;
esac
