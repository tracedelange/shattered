#!/usr/bin/env bash
set -euo pipefail

pm2 delete mmo
pm2 save

echo "[mmo] Server stopped."
