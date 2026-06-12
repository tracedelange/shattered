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

# --- Expansion scope (edit these) --------------------------------------------
# CENTER is the origin the sticky loop expands outward from (defaults to the
# player spawn village). RADIUS bounds each region's neighborhood, forwarded to
# the gardener so its metrics + opportunity scope stay bounded. Any extra args
# passed to this script are appended (and override these).
CENTER="village_4_29"
RADIUS="3"
# -----------------------------------------------------------------------------

# --- LLM endpoint ------------------------------------------------------------
# Resolves PIPELINE_BASE_URL / PIPELINE_MODEL / PIPELINE_AUTH_TOKEN from the
# provider block (anthropic | ollama) selected by PIPELINE_PROVIDER, defined in
# .env. Tokens live only in .env — never hardcode them here. Switch per run:
#   PIPELINE_PROVIDER=ollama tools/ollama-loop.sh
source "$REPO_ROOT/tools/lib/llm-env.sh"
# -----------------------------------------------------------------------------

cd "$REPO_ROOT"
npx tsx pipeline/loop.ts --sticky --center "$CENTER" --radius "$RADIUS" "$@"
