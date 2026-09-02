# CLAUDE.md

Agent instructions for this repo. `README.md` is the map (what exists, where it
lives, which invariants not to break) — read it first for anything structural.
`CONTRIBUTING.md` covers commit messages, squash-merge, and deploys.

## Checks

Three gates, all runnable locally, all run on every PR by `.github/workflows/ci.yml`:

```bash
npm run typecheck   # tsc --noEmit across root/server, client, pipeline, tools
npm run lint        # eslint (eslint.config.js) — warnings are OK, errors are not
npm test            # vitest, unit tests only
npm run test:gen    # mapgen fixture harness (slower, renders PNGs — run when touching mapgen)
```

Run the ones your change touches before saying the work is done. `npm test` is
fast enough to run always.

## Unit tests

Tests live **next to the code they cover**, as `<module>.test.ts`, and import
from `vitest` explicitly (no globals). See `server/game/items/pricing.test.ts`
and `shared/worldgen/noise.test.ts` for the shape.

**Add tests when you change pure logic** — a formula, a resolution rule, an
invariant. In this repo that means:

- Pricing, loot rolls, affix budgets (`server/game/items/`)
- Stat aggregation, damage, threat, faction/targeting (`server/game/systems/`)
- Determinism-contract code — anything under `shared/worldgen/`, `shared/`
  constants-driven math, mapgen primitives. Same seed → same output is a
  testable claim; make it one.
- Validators and parsers (`pipeline/lib/`, `forge/lib/`) — feed them a bad input
  and assert the error, not just the happy path.

**Don't** reach for a unit test when the thing under change is a socket handler,
a live world mutation, an LLM call, or canvas rendering. Those need a running
world or a model; `npm run test:gen` and the workbenches under `tools/` are the
harnesses for that, and a mock-heavy unit test there tests the mock.

A good test here asserts a *rule* ("a debuff-shaped stat never prices an item
below its base"), not a snapshot of today's numbers. Prefer importing the tuning
constant over hardcoding its current value, so a balance change doesn't produce
a wall of false failures.

## Style

Match the surrounding code. This codebase comments the **why** — the tradeoff, the
bug that motivated the shape, the doc it implements — and does not comment the
what. New code should read the same way. Touch only what the task requires; a
drive-by rename costs more review than it saves.
