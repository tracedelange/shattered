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
}

function loadDir(dir: string): { id: string; path: string; body: string }[] {
  return listYamlFiles(dir).map((path) => {
    const body = readText(path);
    const idMatch = body.match(/^id:\s*([A-Za-z0-9_]+)/m);
    const id = idMatch ? idMatch[1] : path;
    return { id, path, body };
  });
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

export function loadWorldBundle(): WorldBundle {
  return {
    loreBible: fileExists(LORE_FILE) ? readText(LORE_FILE) : '',
    zones: loadDir(join(WORLD_DIR, 'zones')),
    mobs: loadDir(join(WORLD_DIR, 'entities', 'mobs')),
    quests: loadDir(join(WORLD_DIR, 'quests')),
    tilesets: loadTilesets(),
    opportunitiesRaw: fileExists(OPPS_FILE) ? readText(OPPS_FILE) : '',
    historyRaw: fileExists(HISTORY_FILE) ? readText(HISTORY_FILE) : '',
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

/**
 * Serialises computed WorldMetrics into a context block for the Gardener.
 * Placed as a dedicated section so the LLM can reference hard numbers when
 * enforcing structural rules (branching factor, region depth, etc.) without
 * re-deriving them from the raw zone YAMLs.
 */
export function formatMetricsContext(metrics: WorldMetrics): string {
  return '# World Metrics (auto-generated — do not edit)\n\n```yaml\n' +
    yaml.dump(metrics, { lineWidth: -1, noRefs: true }).trim() +
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
  const relevant = new Set(seedIds);
  for (const z of zones) {
    if (relevant.has(z.id)) {
      for (const n of z.connected_to) relevant.add(n);
    }
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

  const deepen = metrics.signals.deepen_candidates.filter((d) => expandedZoneIds.has(d.zone));
  if (deepen.length) signals.deepen_candidates = deepen;

  const atMax = metrics.signals.at_max_branching.filter((z) => expandedZoneIds.has(z));
  if (atMax.length) signals.at_max_branching = atMax;

  const noSpawn = metrics.signals.no_spawn_zones.filter((z) => expandedZoneIds.has(z));
  if (noSpawn.length) signals.no_spawn_zones = noSpawn;

  const inaccessible = metrics.signals.inaccessible_tile_zones.filter((d) => expandedZoneIds.has(d.zone));
  if (inaccessible.length) signals.inaccessible_tile_zones = inaccessible;

  const accessDefault = metrics.signals.accessible_default_zones.filter((d) => expandedZoneIds.has(d.zone));
  if (accessDefault.length) signals.accessible_default_zones = accessDefault;

  const relevantClusters = metrics.graph.clusters.filter((c) =>
    c.members.some((m) => expandedZoneIds.has(m)),
  );
  const relevantOrphans = metrics.graph.narrative_orphans.filter((id) => expandedZoneIds.has(id));

  const graphSummary: Record<string, unknown> = {
    total_zones: metrics.graph.total_zones,
    connected_components: metrics.graph.connected_components,
    avg_connection_degree: metrics.graph.avg_connection_degree,
    dead_ends: metrics.graph.dead_ends,
    high_degree_zones: metrics.graph.high_degree_zones,
  };
  if (relevantClusters.length) graphSummary.clusters = relevantClusters;
  if (relevantOrphans.length) graphSummary.narrative_orphans = relevantOrphans;

  const block: Record<string, unknown> = {
    graph_summary: graphSummary,
    zones,
  };
  if (Object.keys(signals).length) block.signals = signals;

  return (
    '# Zone Metrics (auto-generated — relevant zones + neighbours)\n\n```yaml\n' +
    yaml.dump(block, { lineWidth: -1, noRefs: true }).trim() +
    '\n```'
  );
}
