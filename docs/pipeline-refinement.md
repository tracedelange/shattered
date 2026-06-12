 ---
  What the logs show

  ┌─────────────────────────┬────────────┬──────────────┬────────┬───────┐
  │       Opportunity       │ Plan cost  │ Execute cost │ Total  │ Turns │
  ├─────────────────────────┼────────────┼──────────────┼────────┼───────┤
  │ new_zone (firdale, old) │ $0.15      │ $2.08        │ $2.23  │ 14    │
  ├─────────────────────────┼────────────┼──────────────┼────────┼───────┤
  │ new_zone (goblin_wood)  │ $0.15      │ $0.74        │ $0.89  │ 5     │
  ├─────────────────────────┼────────────┼──────────────┼────────┼───────┤
  │ add_quest               │ $0.08–0.17 │ $0.20–0.23   │ ~$0.36 │ 2–7   │
  └─────────────────────────┴────────────┴──────────────┴────────┴───────┘

  With the render loop fix, new_zone should land closer to goblin_wood's ~$0.89. But there's still a lot of LLM work that doesn't need to be LLM work.

  ---
  Roadmap: highest ROI first

  1. Skip plan phase for non-zone opportunities (easy, ~$0.10 saved per quest/entity)

  For add_quest, add_entity, refactor_lore, add_connection the plan call produces zones: [] plus a list of entities_needed — information that's almost entirely derivable from the opportunity itself (suggested_entities field + world state).
  It costs $0.08–0.17 per invocation and adds ~35–80 seconds.

  Fix: in the implementer, check opportunity.type. If it's a type that produces zones: [] in practice, skip the plan call and derive entities_needed from opportunity.suggested_entities. Saves the plan call entirely for ~60% of
  opportunities.

  ---
  2. Bidirectional connection auto-sync (easy, saves one full file-read+write per new_zone)

  When zone A declares connections: { west: zone_b }, the LLM currently also reads zone_b.yaml and re-writes the whole thing just to add connections: { east: zone_a }. That's an entire read → modify → write tool call sequence on a
  potentially large file, and a common source of bugs (the LLM will mangle zone_b's ops while copying them).

  Fix: after the implementer writes all files, scan the written zones for connections that have no reverse in the existing world. Patch the existing YAML in-place (just inserting the connections key, not re-writing the whole file). The LLM
  only writes new zones and never touches existing zone files for connection wiring. Very similar to auto-portal synthesis.

  ---
  3. Execute YAML skeleton from plan (medium, ~$0.20–0.40 saved per zone)

  The plan already produces: archetype, connections, width/height, default_tile, layout_sketch (prose), and spawn_summary. The execute call then writes the full zone YAML from scratch — structural boilerplate and all.

  Fix: after the plan call, generate a partially-filled zone YAML template:
  - Header fields from plan (id, tileset, width, height, default_tile, archetype)
  - The right generator op recipe for the archetype (cave/bsp/village — from tools/generator-fixtures/)
  - connections: from the plan
  - ensure_reach pre-included as the last op (so the LLM can't forget it)
  - spawn_point: { focal: true } pre-filled

  The execute call gets this template as a starting point and fills in: region IDs, mob names, lore hooks, landmark region, noise seeds, specific counts. Output tokens drop significantly because the LLM is editing a skeleton, not writing
  from scratch. This also eliminates ensure_reach amnesia and wrong default_tile as bug classes.

  ---
  4. Auto-inject ensure_reach when connectivity check fails (medium, eliminates repair turns)

  After the execute call writes a zone and the host runs the connectivity check, if inaccessibleTiles > 0: instead of either committing the broken zone or re-running the whole execute call, programmatically inject an ensure_reach op at the
  end of the zone's ops list, using the connection entry tiles as seeds. Re-check. Commit only when clean.

  This is "Option B" from the render-loop discussion. Combined with #3 (ensure_reach pre-included in skeleton), this becomes a safety net for the rare case where the generated cave/bsp still produces an isolated pocket.

  ---
  5. Zone richness pre-score in gardener context (low effort, reduces gardener turns)

  The gardener already has signals.deepen_candidates and similar. Add an explicit richness_score per zone in the metrics output — a computed 0–10 score based on: region count, spawn density, has landmark, has quest hook, all connections
  reachable, lore hooks written. This gives the gardener a single number to reason from instead of re-deriving it. Reduces the gardener's analysis tokens and makes the depth-before-breadth rule easier to enforce.

  ---
  6. Lore bible entry auto-generation (low effort, saves lore_update tokens)

  For new zones, the LLM writes a prose lore_update.zones_append entry. Most of the structured content (zone id, connections, factions, date) is deterministic from what was just written. Auto-generate the zones_append entry in the
  implementer host code from the written zone's fields, leaving the LLM to write only the summary sentence. Saves ~200–400 output tokens per zone.

  ---
  My suggested priority order

  Do next (1–2 sessions):
  1 → 2 → 4 — these are all host-code changes, low risk, immediate payoff per run.

  Do after (1 session each):
  3 → 5 — 3 requires the generator fixtures to be formalized as templates; 5 is a metrics extension.

  Do whenever: 6 — small savings, do alongside something else.

  What do you want to start with?