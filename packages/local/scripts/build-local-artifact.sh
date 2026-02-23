#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MANIFEST_PATH="$ROOT_DIR/packages/local/Cargo.toml"
OUT_DIR="$ROOT_DIR/packages/local/dist"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

asset_name() {
  case "${OS}:${ARCH}" in
    darwin:arm64|darwin:aarch64)
      echo "local-darwin-arm64"
      ;;
    darwin:x86_64|darwin:amd64)
      echo "local-darwin-x64"
      ;;
    linux:x86_64|linux:amd64)
      echo "local-linux-x64"
      ;;
    msys*:x86_64|mingw*:x86_64|cygwin*:x86_64)
      echo "local-windows-x64.exe"
      ;;
    *)
      echo "Unsupported platform: ${OS}/${ARCH}" >&2
      exit 1
      ;;
  esac
}

ASSET="$(asset_name)"
BIN_PATH="$ROOT_DIR/packages/local/target/release/local"
if [[ "$ASSET" == *.exe ]]; then
  BIN_PATH="$ROOT_DIR/packages/local/target/release/local.exe"
fi

cargo build --release --manifest-path "$MANIFEST_PATH"

mkdir -p "$OUT_DIR"
cp "$BIN_PATH" "$OUT_DIR/$ASSET"
if [[ "$ASSET" != *.exe ]]; then
  chmod 755 "$OUT_DIR/$ASSET"
fi

echo "Built $OUT_DIR/$ASSET"
