#!/usr/bin/env bash
# Run the gardener against a local Ollama model.
# Usage: tools/ollama-gardener.sh [extra gardener args...]
#   tools/ollama-gardener.sh --dry-run
#   tools/ollama-gardener.sh --anchor zone_001
set -euo pipefail

# --- LLM endpoint ------------------------------------------------------------
# Defaults target Ollama Cloud; override in your shell to run elsewhere, e.g.:
#   PIPELINE_BASE_URL=http://localhost:11434 PIPELINE_MODEL=qwen3:14b tools/ollama-gardener.sh
#
# NEVER hardcode the auth token here. Export PIPELINE_AUTH_TOKEN in your shell
# or an untracked .env (then `set -a; source .env; set +a` before running).
export PIPELINE_BASE_URL="${PIPELINE_BASE_URL:-https://ollama.com}"
export PIPELINE_MODEL="${PIPELINE_MODEL:-gemma4:31b-cloud}"
if [[ "$PIPELINE_BASE_URL" == *ollama.com* ]]; then
  : "${PIPELINE_AUTH_TOKEN:?Ollama Cloud requires PIPELINE_AUTH_TOKEN — export it in your shell or .env (do not hardcode it)}"
fi
export PIPELINE_AUTH_TOKEN="${PIPELINE_AUTH_TOKEN:-}"
# -----------------------------------------------------------------------------

cd "$(dirname "$0")/.."
npx tsx pipeline/gardener.ts --anchor village_41_41 --radius 2 --no-commit
