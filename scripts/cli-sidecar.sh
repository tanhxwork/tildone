#!/usr/bin/env bash
# Build the tildone-axi CLI and put it where Tauri's externalBin expects it:
# src-tauri/binaries/tildone-axi-<target-triple>[.exe].
#
# Run by the release overlay's beforeBuildCommand (src-tauri/tauri.release.conf.json),
# where Tauri sets TAURI_ENV_TARGET_TRIPLE to the --target of the app build, so a
# cross build (aarch64 -> x86_64 macOS) gets a sidecar for its own target.
# Run by hand it builds for the host. `bun run cli:sidecar`.
set -eu
cd "$(dirname "$0")/.."

triple=${TAURI_ENV_TARGET_TRIPLE:-}
if [ -z "$triple" ]; then
  triple=$(rustc -vV | sed -n 's/^host: //p')
fi
[ -n "$triple" ] || { echo "cli-sidecar: cannot determine the target triple" >&2; exit 1; }

case "$triple" in *windows*) ext=.exe ;; *) ext= ;; esac

cargo build --release --manifest-path cli/Cargo.toml --target "$triple"

# cli/ is standalone, so its target dir is cli/target unless CARGO_TARGET_DIR says otherwise.
src="${CARGO_TARGET_DIR:-cli/target}/$triple/release/tildone-axi$ext"
[ -f "$src" ] || { echo "cli-sidecar: built binary not found at $src" >&2; exit 1; }

mkdir -p src-tauri/binaries
dest="src-tauri/binaries/tildone-axi-$triple$ext"
cp "$src" "$dest"
echo "cli-sidecar: $dest"
