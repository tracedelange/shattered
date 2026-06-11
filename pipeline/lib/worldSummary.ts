// Builds the static, cacheable "this is the world" context block for both
// pipelines. Reads raw YAML text where possible so the LLM sees the same
// representation that humans edit.

import { basename } from 'node:path';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  listYamlFiles, listJsonFiles, readText, fileExists,
  WORLD_DIR, LORE_FILE, TILESETS_DIR, OPPS_FILE, HISTORY_FILE,
} from './io.ts';
import type { WorldMetrics, ZoneMetrics } from './worldMetrics.ts';

export interface WorldBundle {
  loreBible: string;
  zones: { id: string; path: string; body: string }[];
  mobs: { id: string; path: string; body: string }[];
  quests: { id: string; path: string; body: string }[];
  tilesets: { id: string; path: string; body: string }[];
  opportunitiesRaw: string;
  historyRaw: string;
  // Present only in broad mode (no zoneFilter). Compact summary of JSON-only
  // stub zones so the gardener knows the world structure without 1000s of stubs
  // flooding the context.
  stubCensus?: string;
}

function loadDir(dir: string): { id: string; path: string; body: string }[] {
  return listYamlFiles(dir).map((path) => {
    const body = readText(path);
    const idMatch = body.match(/^id:\s*([A-Za-z0-9_]+)/m);
    const id = idMatch ? idMatch[1] : path;
    return { id, path, body };
  });
}

// Loads zone files from a directory — both YAML and JSON. Used for anchor-mode
// sweeps where the caller supplies an explicit zoneFilter.
function loadZoneFiles(
  dir: string,
  zoneFilter: Set<string>,
): { id: string; path: string; body: string }[] {
  const yamlEntries = listYamlFiles(dir).map((path) => {
    const body = readText(path);
    const idMatch = body.match(/^id:\s*([A-Za-z0-9_]+)/m);
    const id = idMatch ? idMatch[1] : path;
    return { id, path, body };
  });
  const jsonEntries = listJsonFiles(dir).map((path) => {
    const body = readText(path);
    const idMatch = body.match(/"id"\s*:\s*"([^"]+)"/);
    const id = idMatch ? idMatch[1] : path;
    return { id, path, body };
  });
  return [...yamlEntries, ...jsonEntries]
    .filter((z) => zoneFilter.has(z.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Builds a compact census of JSON-only stub zones for broad-mode context.
// Groups stubs by biome and level tier so the gardener understands world
// structure without ingesting thousands of near-identical stub bodies.
function buildStubCensus(dir: string, authoredIds: Set<string>): string {
  const byBiome: Record<string, Record<number, number>> = {};
  let total = 0;
  for (const path of listJsonFiles(dir)) {
    const body = readText(path);
    const idMatch = body.match(/"id"\s*:\s*"([^"]+)"/);
    const id = idMatch ? idMatch[1] : '';
    if (authoredIds.has(id)) continue; // already in authored zones
    const biomeMatch = body.match(/"biome"\s*:\s*"([^"]+)"/);
    const tierMatch = body.match(/"tier"\s*:\s*(\d)/);
    const biome = biomeMatch ? biomeMatch[1] : 'unknown';
    const tier = tierMatch ? Number(tierMatch[1]) : 0;
    byBiome[biome] ??= {};
    byBiome[biome][tier] = (byBiome[biome][tier] ?? 0) + 1;
    total++;
  }
  if (total === 0) return '';
  const lines = [`${total} unbuilt stub zones (JSON-only, no authored content):`];
  for (const [biome, tiers] of Object.entries(byBiome).sort()) {
    const tierSummary = Object.entries(tiers)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([tier, count]) => `tier${tier}×${count}`)
      .join(', ');
    lines.push(`  ${biome}: ${tierSummary}`);
  }
  lines.push('Use --anchor <zone_id> to bootstrap a specific region.');
  return lines.join('\n');
}

function loadTilesets(): { id: string; path: string; body: string }[] {
  return listJsonFiles(TILESETS_DIR).map((path) => {
    const body = readText(path);
    let id = basename(path, '.json');
    const m = body.match(/"name"\s*:\s*"([^"]+)"/);
    if (m) id = m[1];
    return { id, path, body };
  });
}

export function loadWorldBundle(options?: { zoneFilter?: Set<string> }): WorldBundle {
  const zonesDir = join(WORLD_DIR, 'zones');
  let zones: WorldBundle['zones'];
  let stubCensus: string | undefined;

  if (options?.zoneFilter) {
    // Anchor mode: load both YAML and JSON for the filtered neighborhood.
    zones = loadZoneFiles(zonesDir, options.zoneFilter);
  } else {
    // Broad mode: authored YAML zones only. Replace JSON stubs with a census
    // so the gardener knows the world structure without flooding context.
    zones = loadDir(zonesDir);
    const authoredIds = new Set(zones.map((z) => z.id));
    const census = buildStubCensus(zonesDir, authoredIds);
    if (census) stubCensus = census;
  }

  return {
    loreBible: fileExists(LORE_FILE) ? readText(LORE_FILE) : '',
    zones,
    mobs: loadDir(join(WORLD_DIR, 'entities', 'mobs')),
    quests: loadDir(join(WORLD_DIR, 'quests')),
    tilesets: loadTilesets(),
    opportunitiesRaw: fileExists(OPPS_FILE) ? readText(OPPS_FILE) : '',
    historyRaw: fileExists(HISTORY_FILE) ? readText(HISTORY_FILE) : '',
    stubCensus,
  };
}

// Big cacheable text block of every world YAML, prefixed with the file path
// so the LLM can reason about layout.
export function formatWorldContext(b: WorldBundle): string {
  const sections: string[] = [];
  sections.push('# Lore Bible\n\n```yaml\n' + b.loreBible + '\n```');

  sections.push('# Zones\n');
  for (const z of b.zones) {
    sections.push(`## ${z.id} (${z.path})\n\n\`\`\`yaml\n${z.body}\n\`\`\``);
  }

  sections.push('# Mobs\n');
  for (const m of b.mobs) {
    sections.push(`## ${m.id} (${m.path})\n\n\`\`\`yaml\n${m.body}\n\`\`\``);
  }

  sections.push('# Quests\n');
  for (const q of b.quests) {
    sections.push(`## ${q.id} (${q.path})\n\n\`\`\`yaml\n${q.body}\n\`\`\``);
  }

  sections.push('# Tilesets\n');
  for (const t of b.tilesets) {
    sections.push(`## ${t.id} (${t.path})\n\n\`\`\`json\n${t.body}\n\`\`\``);
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Compact world context (Gardener)
// ---------------------------------------------------------------------------
// The Gardener finds *opportunities* — it reasons over what each zone/mob/quest
// IS (theme, connections, role) plus the structural metrics block, not the full
// generator op-lists, dialogue trees, or quest-stage YAML. That detail is the
// Implementer's concern, and the Implementer already pulls it via focused
// context. Emitting per-entity summaries instead of full bodies cuts this block
// from ~33k tokens to ~11k so the Gardener fits a small local model's window.

function safeLoad(body: string): Record<string, unknown> | null {
  try {
    const d = yaml.load(body);
    return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Drop the heavy `ops` and `spawns` arrays; keep all the small structural fields
// (archetype, landmark, connections, dimensions) and replace the dropped arrays
// with summaries: named regions, op type/count, per-entity spawn counts, and the
// zones each portal leads to. Unparseable bodies fall back to raw text.
function summarizeZone(body: string): string {
  const d = safeLoad(body);
  if (!d) return body;
  const ops = Array.isArray(d.ops) ? (d.ops as Record<string, unknown>[]) : [];
  const spawns = Array.isArray(d.spawns) ? (d.spawns as Record<string, unknown>[]) : [];
  const portals = Array.isArray(d.portals) ? (d.portals as Record<string, unknown>[]) : [];

  const byEntity: Record<string, number> = {};
  for (const s of spawns) {
    const id = String(s.entity ?? s.template ?? s.id ?? 'unknown');
    byEntity[id] = (byEntity[id] ?? 0) + (Number(s.count) || 1);
  }
  const regions = ops.filter((o) => o.type === 'region' && o.id).map((o) => o.id);
  const opTypes = [...new Set(ops.map((o) => o.type).filter(Boolean))];
  const portalsTo = [...new Set(portals.map((p) => (p.to as { zone?: string })?.zone).filter(Boolean))];

  const summary: Record<string, unknown> = { ...d };
  delete summary.ops;
  delete summary.spawns;
  delete summary.portals;
  if (regions.length) summary.regions = regions;
  summary.ops_summary = { count: ops.length, types: opTypes };
  if (spawns.length) summary.spawns_summary = { groups: spawns.length, by_entity: byEntity };
  if (portalsTo.length) summary.portals_to = portalsTo;

  return yaml.dump(summary, { lineWidth: -1, noRefs: true }).trim();
}

// Mobs are small except for `dialogue`; drop it (the Gardener doesn't write lines).
function summarizeMob(body: string): string {
  const d = safeLoad(body);
  if (!d) return body;
  const summary: Record<string, unknown> = { ...d };
  delete summary.dialogue;
  return yaml.dump(summary, { lineWidth: -1, noRefs: true }).trim();
}

// Keep the quest premise (giver, zone, description, rewards); replace the full
// `stages` objective YAML with a count + stage ids.
function summarizeQuest(body: string): string {
  const d = safeLoad(body);
  if (!d) return body;
  const stages = Array.isArray(d.stages) ? (d.stages as Record<string, unknown>[]) : [];
  const summary: Record<string, unknown> = { ...d };
  delete summary.stages;
  if (stages.length) {
    summary.stages_summary = { count: stages.length, ids: stages.map((s) => s.id).filter(Boolean) };
  }
  return yaml.dump(summary, { lineWidth: -1, noRefs: true }).trim();
}

/**
 * Compact variant of formatWorldContext for the Gardener: per-entity summaries
 * instead of full bodies, and no tilesets (the Gardener proposes opportunities,
 * not tile authoring — the Implementer gets full tilesets via focused context).
 */
export function formatWorldContextCompact(b: WorldBundle): string {
  const sections: string[] = [];
  sections.push('# Lore Bible\n\n```yaml\n' + b.loreBible + '\n```');

  sections.push('# Zones (summaries — full op-lists omitted; loaded per-zone at implementation time)\n');
  for (const z of b.zones) {
    sections.push(`## ${z.id} (${z.path})\n\n\`\`\`yaml\n${summarizeZone(z.body)}\n\`\`\``);
  }
  if (b.stubCensus) {
    sections.push('## Unbuilt stub zones (census)\n\n```\n' + b.stubCensus + '\n```');
  }

  sections.push('# Mobs (summaries — dialogue omitted)\n');
  for (const m of b.mobs) {
    sections.push(`## ${m.id} (${m.path})\n\n\`\`\`yaml\n${summarizeMob(m.body)}\n\`\`\``);
  }

  sections.push('# Quests (summaries — stage detail omitted)\n');
  for (const q of b.quests) {
    sections.push(`## ${q.id} (${q.path})\n\n\`\`\`yaml\n${summarizeQuest(q.body)}\n\`\`\``);
  }

  return sections.join('\n\n');
}

// How many recent history entries to surface in the Gardener context. The full
// history.yaml is still read directly (for monotonic-ID collision avoidance) —
// this only bounds what's serialized into the prompt, where only recent work is
// relevant to opportunity-finding.
const HISTORY_CONTEXT_LIMIT = 15;

// Keep only the most recent N history entries in the serialized block. Falls
// back to the raw text if it doesn't parse to the expected shape.
function trimHistory(historyRaw: string): string {
  try {
    const doc = yaml.load(historyRaw) as { entries?: unknown[] } | null;
    const entries = doc?.entries;
    if (!Array.isArray(entries) || entries.length <= HISTORY_CONTEXT_LIMIT) return historyRaw;
    const recent = entries.slice(-HISTORY_CONTEXT_LIMIT);
    const omitted = entries.length - recent.length;
    return (
      `# (${omitted} older entries omitted; ${recent.length} most recent shown)\n` +
      yaml.dump({ entries: recent }, { lineWidth: -1, noRefs: true }).trim()
    );
  } catch {
    return historyRaw;
  }
}

export function formatPipelineState(b: WorldBundle): string {
  return [
    '# Current opportunities.yaml\n\n```yaml\n' + b.opportunitiesRaw + '\n```',
    '# Implementation history (recent)\n\n```yaml\n' + trimHistory(b.historyRaw) + '\n```',
  ].join('\n\n');
}

// How many recent implementations feed the anti-repetition digest.
const DIGEST_LIMIT = 10;

/**
 * Compact anti-repetition digest from history.yaml: the types and targets of
 * the last N implementations, plus a standing instruction. ~50 tokens that
 * directly counter the LLM's tendency to propose the same opportunity shape
 * batch after batch. Returns '' when history is empty or untyped (old runs).
 */
export function formatRecentWorkDigest(historyRaw: string): string {
  let entries: Array<{ type?: string; target_zone?: string }> = [];
  try {
    const doc = yaml.load(historyRaw) as { entries?: Array<{ type?: string; target_zone?: string }> } | null;
    entries = (doc?.entries ?? []).slice(-DIGEST_LIMIT).filter((e) => e.type);
  } catch { /* unreadable history — skip the digest */ }
  if (entries.length === 0) return '';

  const counts = new Map<string, { n: number; targets: Set<string> }>();
  for (const e of entries) {
    const c = counts.get(e.type!) ?? { n: 0, targets: new Set<string>() };
    c.n++;
    if (e.target_zone) c.targets.add(e.target_zone);
    counts.set(e.type!, c);
  }
  const lines = [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([type, c]) => `- ${type} ×${c.n}${c.targets.size ? ` (${[...c.targets].join(', ')})` : ''}`);

  return [
    '# Recently implemented (last ' + entries.length + ')',
    '',
    ...lines,
    '',
    'Vary the batch: do not propose more than two opportunities of any one',
    'type, and prefer zones not in the list above unless a signal demands it.',
  ].join('\n');
}

/**
 * Serialises computed WorldMetrics into a context block for the Gardener.
 * Placed as a dedicated section so the LLM can reference hard numbers when
 * enforcing structural rules (branching factor, region depth, etc.) without
 * re-deriving them from the raw zone YAMLs.
 */
export function formatMetricsContext(metrics: WorldMetrics, zoneFilter?: Set<string>): string {
  const inScope = (id: string) => !zoneFilter || zoneFilter.has(id);

  const s = metrics.signals;
  const signals: Record<string, unknown> = {
    frontier: s.frontier.filter((f) => inScope(f.zone)),
    unnamed_inhabited_zones: s.unnamed_inhabited_zones.filter(inScope),
    questless_settlements: s.questless_settlements.filter(inScope),
    inaccessible_tile_zones: s.inaccessible_tile_zones.filter((d) => inScope(d.zone)),
    accessible_default_zones: s.accessible_default_zones.filter((d) => inScope(d.zone)),
  };

  // The per-zone array is the bulk (one row per zone — ~1700 on a full world).
  // In scoped (anchor) mode, include only the neighborhood. In broad mode,
  // include only developed zones so the block never balloons.
  const block: Record<string, unknown> = {
    graph_summary: metrics.graph,
    composition: metrics.composition,
    signals,
  };
  if (zoneFilter) {
    block.zones = metrics.zones.filter((z) => zoneFilter.has(z.id));
  } else {
    block.zones = metrics.zones.filter((z) => z.development > 0);
    block.zones_note =
      `${metrics.zones.length} zones total; rows shown only for developed zones. ` +
      `Undeveloped stubs are uniform worldgen output — see composition for their biome mix.`;
  }

  return '# World Metrics (auto-generated — do not edit)\n\n```yaml\n' +
    yaml.dump(block, { lineWidth: -1, noRefs: true }).trim() +
    '\n```';
}

/**
 * Produces a focused metrics block for the Implementer containing only the
 * zones directly relevant to the current opportunity plus their immediate
 * neighbours. Signals are filtered to the same zone set.
 *
 * This keeps the context tight while giving both Implementer phases the hard
 * structural numbers they need (region count, walkable tiles, inaccessible
 * tiles, spawn density, connection degree) without having to re-derive them
 * from raw YAML.
 *
 * @param metrics          Full WorldMetrics snapshot (from computeWorldMetrics).
 * @param relevantZoneIds  Zone IDs named in the opportunity (target zone, etc.).
 *                         Unknown IDs (e.g. a brand-new zone) are silently ignored.
 */
/**
 * Expands a seed set of zone IDs to include their immediate neighbours.
 * Call this once in main() and pass the result to both formatImplementerMetrics
 * and formatFocusedWorldContext so the expansion only happens once.
 */
export function expandRelevantZones(seedIds: string[], zones: ZoneMetrics[]): Set<string> {
  // One ring only: the seeds plus their immediate neighbours. Expand from the
  // ORIGINAL seeds, not the growing set — otherwise a single forward pass
  // cascades transitively across an entire connected component (every newly
  // added neighbour that appears later in the array pulls in its own
  // neighbours), which on a fully-connected world floods to ~all zones.
  const relevant = new Set(seedIds);
  const byId = new Map(zones.map((z) => [z.id, z]));
  for (const id of seedIds) {
    const z = byId.get(id);
    if (z) for (const n of z.connected_to) relevant.add(n);
  }
  return relevant;
}

/**
 * Focused world context for the Implementer — only the zones, mobs, and quests
 * that are relevant to the current opportunity. Always includes the lore bible
 * and all tilesets (small + needed for tile name lookups).
 *
 * @param zoneIds   Pre-expanded zone IDs (relevant + neighbours). Empty set → no zones section.
 * @param entityIds Mob template IDs to include. Empty set → no mobs section.
 * @param questIds  Quest IDs to include. Empty set → no quests section.
 */
export function formatFocusedWorldContext(
  b: WorldBundle,
  zoneIds: Set<string>,
  entityIds: Set<string>,
  questIds: Set<string>,
): string {
  const sections: string[] = [];
  sections.push('# Lore Bible\n\n```yaml\n' + b.loreBible + '\n```');

  const zones = zoneIds.size > 0 ? b.zones.filter((z) => zoneIds.has(z.id)) : [];
  if (zones.length > 0) {
    sections.push('# Zones\n');
    for (const z of zones) {
      sections.push(`## ${z.id} (${z.path})\n\n\`\`\`yaml\n${z.body}\n\`\`\``);
    }
  }

  if (entityIds.size > 0) {
    const mobs = b.mobs.filter((m) => entityIds.has(m.id));
    if (mobs.length > 0) {
      sections.push('# Mobs\n');
      for (const m of mobs) {
        sections.push(`## ${m.id} (${m.path})\n\n\`\`\`yaml\n${m.body}\n\`\`\``);
      }
    }
  }

  if (questIds.size > 0) {
    const quests = b.quests.filter((q) => questIds.has(q.id));
    if (quests.length > 0) {
      sections.push('# Quests\n');
      for (const q of quests) {
        sections.push(`## ${q.id} (${q.path})\n\n\`\`\`yaml\n${q.body}\n\`\`\``);
      }
    }
  }

  sections.push('# Tilesets\n');
  for (const t of b.tilesets) {
    sections.push(`## ${t.id} (${t.path})\n\n\`\`\`json\n${t.body}\n\`\`\``);
  }

  return sections.join('\n\n');
}

export function formatImplementerMetrics(
  metrics: WorldMetrics,
  expandedZoneIds: Set<string>,
): string {
  const zones = metrics.zones.filter((z) => expandedZoneIds.has(z.id));

  // Filter signals to the relevant zone set only.
  const signals: Record<string, unknown> = {};

  const inaccessible = metrics.signals.inaccessible_tile_zones.filter((d) => expandedZoneIds.has(d.zone));
  if (inaccessible.length) signals.inaccessible_tile_zones = inaccessible;

  const accessDefault = metrics.signals.accessible_default_zones.filter((d) => expandedZoneIds.has(d.zone));
  if (accessDefault.length) signals.accessible_default_zones = accessDefault;

  const block: Record<string, unknown> = { zones };
  if (Object.keys(signals).length) block.signals = signals;

  return (
    '# Zone Metrics (auto-generated — relevant zones + neighbours)\n\n```yaml\n' +
    yaml.dump(block, { lineWidth: -1, noRefs: true }).trim() +
    '\n```'
  );
}
