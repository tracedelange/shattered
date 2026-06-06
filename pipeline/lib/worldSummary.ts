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
import type { WorldMetrics } from './worldMetrics.ts';

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

export function formatPipelineState(b: WorldBundle): string {
  return [
    '# Current opportunities.yaml\n\n```yaml\n' + b.opportunitiesRaw + '\n```',
    '# Implementation history\n\n```yaml\n' + b.historyRaw + '\n```',
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
export function formatImplementerMetrics(
  metrics: WorldMetrics,
  relevantZoneIds: string[],
): string {
  // Expand to include immediate neighbours so the LLM understands the local graph.
  const relevant = new Set(relevantZoneIds);
  for (const z of metrics.zones) {
    if (relevant.has(z.id)) {
      for (const n of z.connected_to) relevant.add(n);
    }
  }

  const zones = metrics.zones.filter((z) => relevant.has(z.id));

  // Filter signals to the relevant zone set only.
  const signals: Record<string, unknown> = {};

  const deepen = metrics.signals.deepen_candidates.filter((d) => relevant.has(d.zone));
  if (deepen.length) signals.deepen_candidates = deepen;

  const atMax = metrics.signals.at_max_branching.filter((z) => relevant.has(z));
  if (atMax.length) signals.at_max_branching = atMax;

  const noSpawn = metrics.signals.no_spawn_zones.filter((z) => relevant.has(z));
  if (noSpawn.length) signals.no_spawn_zones = noSpawn;

  const inaccessible = metrics.signals.inaccessible_tile_zones.filter((d) => relevant.has(d.zone));
  if (inaccessible.length) signals.inaccessible_tile_zones = inaccessible;

  const accessDefault = metrics.signals.accessible_default_zones.filter((d) => relevant.has(d.zone));
  if (accessDefault.length) signals.accessible_default_zones = accessDefault;

  const block: Record<string, unknown> = {
    graph_summary: {
      total_zones: metrics.graph.total_zones,
      connected_components: metrics.graph.connected_components,
      avg_connection_degree: metrics.graph.avg_connection_degree,
      dead_ends: metrics.graph.dead_ends,
      high_degree_zones: metrics.graph.high_degree_zones,
    },
    zones,
  };
  if (Object.keys(signals).length) block.signals = signals;

  return (
    '# Zone Metrics (auto-generated — relevant zones + neighbours)\n\n```yaml\n' +
    yaml.dump(block, { lineWidth: -1, noRefs: true }).trim() +
    '\n```'
  );
}
