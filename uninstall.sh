#!/usr/bin/env bash
# Removes the `cmt` binary installed by install.sh.
#
# Run from a local clone, or online without cloning:
#   curl -fsSL https://raw.githubusercontent.com/FabrichJean/c-commit/main/uninstall.sh | bash
set -euo pipefail

BIN_NAME="cmt"
INSTALL_DIR="${CMT_INSTALL_DIR:-$HOME/.local/bin}"
TARGET="$INSTALL_DIR/$BIN_NAME"

if [ ! -f "$TARGET" ]; then
  echo "No '$BIN_NAME' installation found at $TARGET (nothing to do)."
  echo "If you installed it elsewhere, set CMT_INSTALL_DIR to that directory and retry."
  exit 0
fi

rm -f "$TARGET"
echo "Removed $TARGET"
echo ""
echo "Note: if you added $INSTALL_DIR to your PATH manually, you may want to remove that line from your shell profile (~/.zshrc, ~/.bashrc, ...) too."
