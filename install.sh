#!/usr/bin/env bash
# Installs the Claude Commit Planner binary as `cmt`.
#
# Run from a local clone (builds/uses dist/bin/*), or online without cloning:
#   curl -fsSL https://raw.githubusercontent.com/FabrichJean/ccommit/main/install.sh | bash
set -euo pipefail

REPO="FabrichJean/ccommit"
BIN_NAME="cmt"
INSTALL_DIR="${CMT_INSTALL_DIR:-$HOME/.local/bin}"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64) ASSET="commit-planner-macos-arm64" ;;
      x86_64) ASSET="commit-planner-macos-x64" ;;
      *) echo "Unsupported macOS architecture: $ARCH" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64) ASSET="commit-planner-linux-x64" ;;
      *) echo "Unsupported Linux architecture: $ARCH" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $OS. On Windows, run install.ps1 instead." >&2
    exit 1
    ;;
esac

# Local clone (has a real file path with a sibling package.json) vs. piped via curl
# (no real file path) - decides whether to build locally or fetch a GitHub release.
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
REPO_ROOT=""
if [ -n "$SCRIPT_PATH" ] && [ -f "$SCRIPT_PATH" ]; then
  CANDIDATE_ROOT="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  if [ -f "$CANDIDATE_ROOT/package.json" ]; then
    REPO_ROOT="$CANDIDATE_ROOT"
  fi
fi

mkdir -p "$INSTALL_DIR"

if [ -f "$INSTALL_DIR/$BIN_NAME" ]; then
  echo "'$BIN_NAME' is already installed at $INSTALL_DIR/$BIN_NAME."
  echo "Continuing will overwrite it with the latest version."
  echo "To remove it instead, run:"
  echo "  curl -fsSL https://raw.githubusercontent.com/$REPO/main/uninstall.sh | bash"
  echo ""
  REPLY=""
  if { printf "Continue and reinstall/upgrade '%s'? [y/N] " "$BIN_NAME" > /dev/tty && read -r REPLY < /dev/tty; } 2>/dev/null; then
    :
  else
    REPLY="y"
    echo "(no interactive terminal detected - proceeding with upgrade)"
  fi
  case "$REPLY" in
    [yY]*) ;;
    *) echo "Aborted - existing installation left untouched."; exit 0 ;;
  esac
  echo ""
fi

if [ -n "$REPO_ROOT" ]; then
  BINARY_PATH="$REPO_ROOT/dist/bin/$ASSET"

  if [ ! -f "$BINARY_PATH" ]; then
    echo "Compiled binary not found at $BINARY_PATH"
    echo "Building it now via 'npm run compile'..."
    (cd "$REPO_ROOT" && npm run compile)
  fi

  if [ ! -f "$BINARY_PATH" ]; then
    echo "Build did not produce $BINARY_PATH - aborting." >&2
    exit 1
  fi

  cp "$BINARY_PATH" "$INSTALL_DIR/$BIN_NAME"
else
  DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/$ASSET"
  echo "Downloading $ASSET from the latest release of $REPO..."

  TMP_FILE="$(mktemp)"
  trap 'rm -f "$TMP_FILE"' EXIT

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$DOWNLOAD_URL" -O "$TMP_FILE"
  else
    echo "Neither curl nor wget was found - please install one and retry." >&2
    exit 1
  fi

  mv "$TMP_FILE" "$INSTALL_DIR/$BIN_NAME"
  trap - EXIT
fi

chmod +x "$INSTALL_DIR/$BIN_NAME"
echo "Installed '$BIN_NAME' -> $INSTALL_DIR/$BIN_NAME"

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    echo "You're all set - run '$BIN_NAME' from anywhere."
    ;;
  *)
    echo ""
    echo "$INSTALL_DIR is not on your PATH yet. Add this to your shell profile (~/.zshrc, ~/.bashrc, ~/.bash_profile, ...):"
    echo ""
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    echo "Then restart your terminal (or 'source' that file) and run '$BIN_NAME'."
    ;;
esac
