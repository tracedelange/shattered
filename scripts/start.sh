#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p logs

pm2 start ecosystem.config.cjs
pm2 save

echo "[mmo] Server started. Logs: logs/out.log | logs/error.log"
echo "[mmo] Run 'pm2 logs mmo' to tail live output."
