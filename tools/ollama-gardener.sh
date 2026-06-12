#!/usr/bin/env bash
# Run the gardener against a local Ollama model.
# Usage: tools/ollama-gardener.sh [extra gardener args...]
#   tools/ollama-gardener.sh --dry-run
#   tools/ollama-gardener.sh --anchor zone_001
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- LLM endpoint ------------------------------------------------------------
# Resolves PIPELINE_BASE_URL / PIPELINE_MODEL / PIPELINE_AUTH_TOKEN from the
# provider block (anthropic | ollama) selected by PIPELINE_PROVIDER, defined in
# .env. Tokens live only in .env — never hardcode them here. Switch per run:
#   PIPELINE_PROVIDER=ollama tools/ollama-gardener.sh
source "$REPO_ROOT/tools/lib/llm-env.sh"
# -----------------------------------------------------------------------------

cd "$(dirname "$0")/.."
npx tsx pipeline/gardener.ts --anchor village_4_29 --radius 3

# npx tsx pipeline/gardener.ts --anchor zone_40_39 --dry-run