#!/usr/bin/env bash
# Low-cost test run of the implementer using Haiku with minimal token usage.
# Targets the top pending opportunity by default; pass --opportunity <id> to override.
#
# Usage:
#   ./scripts/run-implementer-test.sh
#   ./scripts/run-implementer-test.sh --opportunity opp_008
#   ./scripts/run-implementer-test.sh --dry-run
#   ./scripts/run-implementer-test.sh --plan          # enable two-phase plan+execute

set -euo pipefail
cd "$(dirname "$0")/.."

# PIPELINE_EFFORT is intentionally not set — plan and execute both need medium
# effort to reliably produce YAML. The main cost saving is the Haiku model itself.
PIPELINE_MODEL=claude-haiku-4-5-20251001 \
PIPELINE_MAX_TURNS=30 \
PIPELINE_THINKING=disabled \
npx tsx pipeline/implementer.ts --no-commit "$@"
