# Shared LLM endpoint resolution for the pipeline scripts. SOURCE this (do not
# execute it) after setting REPO_ROOT:  source "$REPO_ROOT/tools/lib/llm-env.sh"
# It loads .env and maps the selected provider onto the canonical vars
# pipeline/lib/llm.ts reads:  PIPELINE_BASE_URL  PIPELINE_MODEL  PIPELINE_AUTH_TOKEN
#
# Define one block per provider in .env (same shape, different prefix):
#   ANTHROPIC_BASE_URL / ANTHROPIC_MODEL / ANTHROPIC_AUTH_TOKEN
#   OLLAMA_BASE_URL    / OLLAMA_MODEL    / OLLAMA_AUTH_TOKEN
#
# PIPELINE_PROVIDER picks the block. Precedence: a value set on the command line
# or in the shell WINS over the .env default, so you can switch per run:
#   PIPELINE_PROVIDER=ollama tools/ollama-loop.sh
# llm.ts sends the token as x-api-key for api.anthropic.com and as a Bearer
# token for everything else, so the same AUTH_TOKEN var works for both.

# Capture a shell/CLI override BEFORE .env can clobber it.
_llm_provider_override="${PIPELINE_PROVIDER:-}"

# Load .env (set -a exports everything so child processes inherit it).
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a; source "$REPO_ROOT/.env"; set +a
fi

# Precedence: CLI/shell override > .env default > built-in default.
PIPELINE_PROVIDER="${_llm_provider_override:-${PIPELINE_PROVIDER:-anthropic}}"
unset _llm_provider_override

# Each canonical var honors a pre-set value first (per-run override, e.g.
# PIPELINE_MODEL=qwen3:14b tools/ollama-loop.sh), then the provider block, then
# a built-in default. .env does not set the canonical PIPELINE_* vars, so a
# command-line value survives the .env load and wins via the :- chain.
case "$PIPELINE_PROVIDER" in
  anthropic)
    export PIPELINE_BASE_URL="${PIPELINE_BASE_URL:-${ANTHROPIC_BASE_URL:-https://api.anthropic.com}}"
    export PIPELINE_MODEL="${PIPELINE_MODEL:-${ANTHROPIC_MODEL:-claude-haiku-4-5}}"
    export PIPELINE_AUTH_TOKEN="${PIPELINE_AUTH_TOKEN:-${ANTHROPIC_AUTH_TOKEN:-}}"
    : "${PIPELINE_AUTH_TOKEN:?anthropic provider needs ANTHROPIC_AUTH_TOKEN in .env}"
    ;;
  ollama)
    export PIPELINE_BASE_URL="${PIPELINE_BASE_URL:-${OLLAMA_BASE_URL:-https://ollama.com}}"
    export PIPELINE_MODEL="${PIPELINE_MODEL:-${OLLAMA_MODEL:-gemma4:31b-cloud}}"
    export PIPELINE_AUTH_TOKEN="${PIPELINE_AUTH_TOKEN:-${OLLAMA_AUTH_TOKEN:-}}"
    # A local Ollama server ignores the token; Ollama Cloud requires it.
    if [[ "$PIPELINE_BASE_URL" == *ollama.com* ]]; then
      : "${PIPELINE_AUTH_TOKEN:?ollama cloud needs OLLAMA_AUTH_TOKEN in .env}"
    fi
    ;;
  *)
    echo "[llm-env] unknown PIPELINE_PROVIDER='$PIPELINE_PROVIDER' (expected: anthropic | ollama)" >&2
    exit 1
    ;;
esac

echo "[llm-env] provider=$PIPELINE_PROVIDER model=$PIPELINE_MODEL base=$PIPELINE_BASE_URL" >&2
