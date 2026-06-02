#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VITE_SERVER_URL=https://soup.graphon.io npm run build
VITE_SERVER_URL=https://soup.graphon.io firebase deploy --only hosting
