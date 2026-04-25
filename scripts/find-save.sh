#!/usr/bin/env bash
# Helper: locate the STS2 save directory on macOS.
set -euo pipefail

DEFAULT="$HOME/Library/Application Support/SlayTheSpire2"

if [ -d "$DEFAULT" ]; then
  echo "Found: $DEFAULT"
  ls -la "$DEFAULT"
  exit 0
fi

echo "Default path not found. Searching under ~/Library..."
find "$HOME/Library" -maxdepth 4 -type d -iname "*spire*" 2>/dev/null || true
echo
echo "If Steam installed it elsewhere, open STS2, press the tilde (~) key,"
echo "type 'open saves' in the debug console, and copy the path."
