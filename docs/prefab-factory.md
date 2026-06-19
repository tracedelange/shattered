# Prefab Factory

A human-in-the-loop content pipeline that mass-produces **prefab set-pieces** —
small, reusable hand-scale rooms (entrances, vaults, shrines, crypts, boss
arenas…) that the world generator stamps into zones. The forge cascade *consumes*
a vocabulary of prefabs; this factory *produces* it.

Status: working slice (Ideate → generate → lint → repair → review, with per-run
persistence and a dedicated UI). **Migrating to a staged pipeline** (see
[Direction](#direction-staged-generation-decided-2026-06)) — Pass 1 shape
primitives are built; Pass 2 op-selection and the renderer track are next.
Accept-to-catalog is not built yet (see [Open work](#open-work)).

---

## Why prefabs, why a factory

Everything we kept hitting — flat zones, no points-of-interest, no
"abandoned castle that leads to a dungeon" — traces back to a missing **content
library**. The engine already supports placing prefabs and wiring portals; what's
missing is a supply of good prefabs. A library entry is reused many times, so the
cost of curating it amortizes — which is exactly why a human gate is affordable
here (unlike per-instance world content, which is too voluminous to review).

The factory is a **separate flow from the tier1/2/3 world cascade**. It shares the
forge's server, socket stream, and model transport, but runs on its own page and
produces library entries rather than a populated world.

---

## The prefab format (direct LLM → ASCII definition)

A prefab is the same shape the engine loads from `world/prefabs/*.json`:

```jsonc
{
  "id": "ruined_tower",
  "description": "A crumbling circular tower base strewn with rubble.",
  "data": "###wwww#####\n##w......w##\n...",   // ASCII grid, rows split on \n
  "legend": { "#": "void", "w": "wall", ".": "stone_floor", "P": "portal", "D": "door" },
  "anchors": { "P": "descend", "D": "entrance" }
}
```

- **`data`** — a literal ASCII grid. One character per tile, rows separated by
  `\n`. This is the spatial layout.
- **`legend`** — maps each grid character to a **tile name from a tileset**
  (`world/tilesets/<name>.json`). Every non-space character in the grid must have
  a legend entry, and every legend tile must actually exist in the brief's
  tileset.
- **`anchors`** — maps a character to a **gameplay tag** (`descend`, `ascend`,
  `loot`, `boss`, `npc`, `entrance`). Anchor cells stay walkable; they're the
  hook points the engine wires up — e.g. an anchored `portal` cell becomes the
  link target when the prefab is placed with `portal_to`.

The model emits this as a single fenced YAML block (a block scalar `data: |` for
the grid); we parse it with the shared `extractYaml`/`parseYaml`.

### Why direct LLM → ASCII is the hard part

Asking a model for a grid in one shot is **blind generation**: the LLM writes the
grid character-by-character in token space and never *sees* the 2D result. The
consequences, observed directly (see [Findings](#findings-from-runs)):

- **Hollow boxes** — an outer wall ring around one empty room, because the model
  can't perceive that the interior is featureless.
- **Disconnected pockets** — internal walls that seal off regions, with no door,
  because connectivity isn't visible token-by-token.
- **Theme drift / mechanical output** — weaker models produce symmetric
  window-pane patterns that satisfy "has internal walls" while looking nothing
  like the brief, and don't anchor to intent (one even renamed the prefab
  mid-repair instead of fixing it).
- **Invisible structure** — a model can pick semantically-correct tiles
  (`cracked_stone_floor` for rubble) that render almost identically to plain
  floor, so the structure doesn't read even though it's "there."

The fix is **not a better one-shot prompt**. It's to stop relying on one shot.

---

## Direction: staged generation (decided 2026-06)

The direct LLM→ASCII loop (below) works with a frontier model but leans on the
exact thing LLMs are worst at — painting coherent 2D geometry cell-by-cell. The
decided architecture moves geometry off the model entirely and splits generation
into stages, so structure *can't* break and the model only does what it's good at
(intent). This is the Gardener/Implementer split applied to layout.

**Pass 1 — deterministic shape primitive (no LLM).** A `shape` field on the brief
(`rect` / `circle` / `bsp` / …) selects a primitive that stamps a
**guaranteed-connected floor mask**; **walls are derived** as the boundary of that
mask, not authored. Output is a structurally-valid base room. Implemented in
`forge/prefab/shapes.ts` — `stampShape` / `deriveRoles` / `stampRoom`. The circle
primitive produces a true rounded silhouette by construction, so "it drew a square,
not a circle" is impossible.

**Pass 2 — LLM as op-selector (not cell-painter).** The LLM chooses from a
vocabulary of **parameterized ops** — `punch_door`, `place_portal`, `place_anchor`,
`add_pillars`, `erode_walls`, `add_alcove`, … — applied deterministically by the
engine. Each op **self-enforces connectivity** (e.g. a pillar that would
disconnect the floor is rejected; a door connects two regions). The model supplies
*intent* (which ops, where, params); the engine guarantees *validity*. _(Next to
build.)_

**Pass 3 — linter as backstop.** The existing linter stays, but as a safety net
that should rarely fire, not the main correction mechanism. The generate→repair
loop becomes a fallback for when ops somehow leave a defect.

**Parallel, independent — renderer does the "ruin."** Wall **autotiling** (pick
the wall sprite from its neighbour mask), **floor variants**, and **decoration
overlays** (rubble, moss, cracks) move "ruined" into the *render*, seeded and
cosmetic. This lets us **relax the contrast directive** and keep the **legend
lean** (`.`/`#` + door/portal/anchors), because structure no longer has to be
spelled out in grid tiles to read.

**The load-bearing separation:**
- **Structural ruination** — wall *gaps*, collapsed corridors, blocked routes:
  these are *gameplay*, so they live in the **grid** (Pass 1/2).
- **Cosmetic ruination** — rubble, moss, cracks, scorch: these are *atmosphere*,
  so they live in the **renderer** as overlays, never in the grid/legend.

Build order: shape primitives + wall-derivation first (done — everything
downstream consumes their output), then the Pass-2 op vocabulary, with the
renderer track proceeding in parallel.

---

## The loop: generate → lint → repair

The core idea: a one-shot is blind, so make it a loop where a **deterministic
linter is the reviewer**. The linter computes the ground-truth structural facts
the model can't see and feeds them back as concrete text defects. This gives the
model "eyes" without a vision model — so it's **text-only and works with local
(Ollama) models**.

```
brief → generate ─→ parse ─→ lint ─→ clean? ──yes──→ done
            ↑                          │
            └────── repair ←──── no (feed grid + defects back)
                    (cap: FORGE_PREFAB_ITERS, default 3)
```

1. **Generate** (`forge/prefab/generate.ts`) — `callLlm` with a system prompt
   (the prefab contract, the tileset's tile names **with colors and blocking
   flags**, the hard rules, and a readability/contrast directive) plus the user
   brief.
2. **Parse** — `parseYaml` → `PrefabCandidate`; a parse failure becomes a defect
   fed back next iteration.
3. **Lint** (`forge/prefab/lint.ts`) — the "eyes" (see below).
4. **Repair** — if there are defects, re-prompt with the model's **own rendered
   grid** plus the concrete defect list, and a **surgical** instruction: keep the
   same id/dimensions/theme/layout and make the *smallest* edit that fixes each
   defect (e.g. swap a boundary wall for a door to connect regions); do not
   rename or redesign. (Weak models otherwise regenerate from scratch.)
5. **Loop** up to `FORGE_PREFAB_ITERS` (default 3), early-exiting when clean.

### The linter (the deterministic "eyes")

`lintPrefab(prefab, brief, { blockingTiles, validTiles })` → `{ ok, defects[], stats }`.
Checks:

| Check | Catches |
|---|---|
| Rectangular grid | ragged rows of unequal length |
| Dimensions vs brief | wrong size |
| Legend completeness | grid chars with no legend entry |
| **Legend tiles valid in tileset** | hallucinated tiles (e.g. `chest` in a tileset that lacks it) |
| Walkable connectivity (flood-fill) | sealed-off regions — must be one connected region |
| Hollow-box detector | a big footprint whose only blocked cells are the border |
| Wall fraction (> 0.7) | too solid |
| Anchors present + walkable | declared anchors missing, or sitting on a wall |

`stats` carries `rows/cols/walkable/blocked/wallFraction/walkableRegions/anchors`,
surfaced in the UI and the report.

**What the linter does NOT do:** judge *taste* or *theme fidelity*. A grid can
pass every check and still look nothing like a "circular ruined tower." Structural
validity ≠ "looks like the brief." That judgment is the human validator's job (or
a future LLM-judge pass) — the lint's role is to ensure you only spend taste on
structurally-sound candidates.

---

## Ideate: the architect (structured brief batches)

`forge/prefab/architect.ts`. Typing one brief at a time doesn't build a library;
asking an LLM for "30 ideas" produces 30 variations of one room. So coverage is
**imposed**, not hoped for:

- A **function taxonomy** is the coverage spine: `entrance`, `boss_arena`,
  `treasure_vault`, `shrine`, `combat_room`, `prison`, `crypt`, `archive`,
  `water_feature`, `chokepoint`, `safe_room`, `monument`.
- The architect LLM is handed the taxonomy + the available tilesets (with tile
  names) + the anchor vocabulary, and asked to span the space — its job is
  *flavor per role*, not deciding what to make (where it would cluster).
- Output is a **zod-validated batch of structured briefs** (`callAndValidate`),
  each: `name`, `purpose`, `tileset`, `width`, `height`, `theme`,
  `required_anchors`, `notes`.

Structured briefs make coverage measurable and let the world cascade later
*query* the library by role. Each batch is saved to `forge/prefab-briefs/`. The
structured fields flow into the builder prompt (required anchors must appear on
walkable tiles, enforced by lint).

---

## Persistence & sharing

`forge/prefab/persist.ts`. Every run writes its own directory under
`forge/prefab-runs/prefab_<timestamp>/`:

| File | Contents |
|---|---|
| `report.md` | Human/AI-readable: outcome, per-iteration defects, final ASCII grid, legend, anchors, model |
| `final.json` | The final candidate in exact engine prefab format (drop-in for `world/prefabs/`) |
| `events.jsonl` | Every event incl. full prompt + raw model output per iteration (complete IO replay) |
| `meta.json` / `summary.json` | brief + model; outcome + lint stats |

Writes happen in a `finally`, so an aborted or errored run still leaves a
readable report. Both the disk append and socket emit are guarded so neither can
skip persistence. (Output dirs are gitignored.)

---

## UI

`forge/ui/prefabs.html`, served by the forge server at `/prefabs.html`. Three
columns:

- **Ideate + Brief** — generate a brief batch, review the list
  (`function · tileset · size · theme · ⚓ anchors`), **Load** into the form or
  **Run** directly. Below it, the editable brief form (name, tileset, size,
  notes, per-run model override).
- **Iterations** — the IO timeline: per iteration, a generate/repair badge, the
  lint verdict + defect list + stats, and collapsible **exact prompt sent** and
  **raw model output**.
- **Preview** — the latest candidate rendered to canvas using real tileset
  colors, plus legend swatches.

---

## Server & models

`forge/server.ts` handles two socket events, streaming results back:

- `prefab_run` (a brief) → `generatePrefab`, emits `prefab` events.
- `architect_run` (a count, 1–40) → `generateBriefs`, emits `architect` events.

Model resolution (env, read at call time):

| Role | Resolution order |
|---|---|
| Builder | `brief.model` (UI field) → `FORGE_PREFAB_MODEL` → `PIPELINE_MODEL` → `claude-sonnet-4-6` |
| Architect | `FORGE_PREFAB_ARCHITECT_MODEL` → `FORGE_PREFAB_MODEL` → `PIPELINE_MODEL` → `claude-sonnet-4-6` |
| Iterations | `FORGE_PREFAB_ITERS` (default 3) |

Run it: `npm run forge:live` (Anthropic via `.env`) or `npm run forge:ollama`
(local), then open `http://localhost:3006/prefabs.html`.

---

## How prefabs get used (consumption side)

For context — the factory produces these; the engine consumes them. A prefab is
placed via a zone's `features` array:

```yaml
features:
  - { id: abandoned_castle_gate, in_region: ruins, portal_to: castle_b1, transition: descend }
```

`compilePrefabFeatureOps` (`server/game/mapgen/zoneFeatures.ts`) turns that into a
footprint-checked `stamp` plus, when `portal_to` is set, a `portal` op targeting
the prefab's anchor. So a prefab with a `portal` anchor is the entrance mechanism
for the "overworld POI → linked sub-zone/dungeon" idea.

---

## Findings from runs

The Ruined Tower brief (12×12) run across models:

- **gemma4:31b-cloud** — mechanical window-pane of sealed cells, disconnected,
  never converged, drifted off-brief (renamed the prefab mid-repair). The loop
  enforces structure but can't make a weak model skilled or instruction-following.
- **claude-sonnet-4-6 / claude-opus-4-8** — both produced genuine circular towers
  and passed lint (opus in 1 iteration, sonnet in 2). The approach is validated
  with a frontier model.
- **Why sonnet "looked better"** — not layout: tile contrast. Sonnet built
  internal structure from `wall` (dark, high contrast); opus used
  `cracked_stone_floor` for rubble, which renders nearly identically to plain
  floor, so its (semantically richer) interior read as a hollow ring. → led to
  the **readability/contrast directive** in the builder prompt.
- **A lint hole** — sonnet's prefab used `chest`, which isn't in the overworld
  tileset, and passed clean. → led to the **legend-tiles-valid-in-tileset** check.

Takeaways: (1) the structural loop works with frontier models; (2) the gap
between "passes lint" and "looks good" is taste + tile choice — the human
validator's job; (3) tile color contrast matters as much as layout for whether
structure reads.

---

## Open work

- **Accept-to-catalog** — promote a clean `final.json` into `world/prefabs/` so
  outputs actually enter the library. (Next increment.)
- **Run-all / batch execution** — run an entire brief batch unattended with a
  queue, rather than one Run at a time.
- **Coverage-gap targeting** — once the catalog has content, feed the architect
  the existing inventory so it fills holes instead of overlapping.
- **Theme/taste layer** — if structural lint isn't enough, an LLM-judge pass that
  grades theme fidelity (reads the ASCII), or keep that with the human gate.
- **If frontier models plateau** — candidate approaches, in order of fit:
  shape scaffold (stamp a silhouette in code, LLM details the interior),
  staged decomposition (mask → rooms → tiles), reference-image conditioning
  (image in, grid out — needs a multimodal model), retrieve-and-mutate (edit the
  nearest accepted prefab).

---

## File map

| File | Role |
|---|---|
| `forge/prefab/types.ts` | `PrefabBrief`, `PrefabCandidate`, lint/event types |
| `forge/prefab/shapes.ts` | Pass 1: deterministic shape primitives + wall derivation |
| `forge/prefab/lint.ts` | deterministic linter (the "eyes" / Pass 3 backstop) |
| `forge/prefab/generate.ts` | generate → lint → repair loop + prompts |
| `forge/prefab/architect.ts` | Ideate: taxonomy + structured brief batch generation |
| `forge/prefab/persist.ts` | per-run persistence (report.md, final.json, …) |
| `forge/server.ts` | `prefab_run` / `architect_run` socket events |
| `forge/ui/prefabs.html` | the UI (Ideate, IO timeline, canvas preview) |
