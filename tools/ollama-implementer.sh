#!/usr/bin/env bash
# Run the implementer against a local Ollama model.
# Usage: tools/ollama-implementer.sh [extra implementer args...]
#   tools/ollama-implementer.sh --dry-run
#   tools/ollama-implementer.sh --opportunity opp_008
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- LLM endpoint ------------------------------------------------------------
# Resolves PIPELINE_BASE_URL / PIPELINE_MODEL / PIPELINE_AUTH_TOKEN from the
# provider block (anthropic | ollama) selected by PIPELINE_PROVIDER, defined in
# .env. Tokens live only in .env — never hardcode them here. Switch per run:
#   PIPELINE_PROVIDER=ollama tools/ollama-implementer.sh
source "$REPO_ROOT/tools/lib/llm-env.sh"
# -----------------------------------------------------------------------------

cd "$(dirname "$0")/.."
npx tsx pipeline/implementer.ts "$@"
