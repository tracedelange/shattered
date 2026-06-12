#!/usr/bin/env bash
# Run the full loop (drain implementer → gardener → repeat) against Ollama.
# Wraps pipeline/loop.ts in --sticky mode: it develops one settlement region to
# saturation, then expands strictly outward (nearest-unsaturated-to-center
# first), growing content ring-by-ring from the spawn village. loop.ts handles
# the drain/refresh cycle, usage-limit stops, and the max-cycle cap. The env
# vars set here are inherited by the implementer/gardener child processes.
#
# Usage: tools/ollama-loop.sh [extra loop args...]
#   tools/ollama-loop.sh --no-commit
#   tools/ollama-loop.sh --center city_29_46          # expand from a different origin
#   LOOP_MAX_CYCLES=10 LOOP_MAX_CYCLES_PER_ANCHOR=6 tools/ollama-loop.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Auto-load an untracked .env at the repo root (e.g. PIPELINE_AUTH_TOKEN=...).
# `set -a` exports everything it defines so child processes inherit it.
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a; source "$REPO_ROOT/.env"; set +a
fi

# --- Expansion scope (edit these) --------------------------------------------
# CENTER is the origin the sticky loop expands outward from (defaults to the
# player spawn village). RADIUS bounds each region's neighborhood, forwarded to
# the gardener so its metrics + opportunity scope stay bounded. Any extra args
# passed to this script are appended (and override these).
CENTER="village_41_41"
RADIUS="2"
# -----------------------------------------------------------------------------

# --- LLM endpoint ------------------------------------------------------------
# Defaults target Ollama Cloud; override any of these in your shell to run
# elsewhere, e.g. against a local server:
#   PIPELINE_BASE_URL=http://localhost:11434 PIPELINE_MODEL=qwen3:14b tools/ollama-loop.sh
#
# NEVER hardcode the auth token here. Put PIPELINE_AUTH_TOKEN in the untracked
# .env at the repo root (auto-loaded above) or export it in your shell.
# llm.ts sends it as the Bearer token; a local server ignores it.
export PIPELINE_BASE_URL="${PIPELINE_BASE_URL:-https://ollama.com}"
export PIPELINE_MODEL="${PIPELINE_MODEL:-gemma4:31b-cloud}"
if [[ "$PIPELINE_BASE_URL" == *ollama.com* ]]; then
  : "${PIPELINE_AUTH_TOKEN:?Ollama Cloud requires PIPELINE_AUTH_TOKEN — export it in your shell or .env (do not hardcode it)}"
fi
export PIPELINE_AUTH_TOKEN="${PIPELINE_AUTH_TOKEN:-}"
# -----------------------------------------------------------------------------

cd "$REPO_ROOT"
npx tsx pipeline/loop.ts --sticky --center "$CENTER" --radius "$RADIUS" "$@"
