#!/usr/bin/env bash
# Skyroom PWA - Dev Server (macOS/Linux)
set -e
cd "$(dirname "$0")"
echo "============================================"
echo "  Skyroom PWA - Dev Server"
echo "============================================"
echo ""
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js not found. Install from https://nodejs.org"
    exit 1
fi
echo "[INFO] Starting server on http://localhost:5173"
echo "[INFO] For mobile, run: ngrok http 5173"
echo ""
node tools/serve.js