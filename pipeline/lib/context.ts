// Zone context builder (Implementor v2, engine change #7).
//
// Before executing an opportunity, the Implementor receives a ZoneContext for
// every referenced zone: the semantic handles it needs to place content without
// ever seeing or emitting X/Y coordinates. `named_regions` and
// `tile_types_present` are derived from the live generated grid; the rest is
// merged from the resolved zone definition and its biome defaults.

import { join } from 'node:path';
import { generateZoneGrid } from '../../server/game/mapgen/index.ts';
import { BIOME_REGISTRY } from '../../server/game/mapgen/biomes/index.ts';
import { loadWorld } from '../../server/world/loader.ts';
import { REPO_ROOT } from './io.ts';
import { mergeFeatures } from '../../server/game/mapgen/biomes/index.ts';
import { FEATURE_REGISTRY } from '../../server/game/mapgen/features/index.ts';
import type { LevelBand, WorldDefs } from '../../shared/types.ts';

export interface ZoneContext {
  id: string;
  biome: string;
  display_name: string;
  level_band: LevelBand | null;
  /** Cardinal + non-cardinal links, direction/label → zone id. */
  connections: Record<string, string>;
  /** Feature operator ids currently active on this zone instance. */
  features: string[];
  /** Region ids produced by the biome pipeline (e.g. building_0, market, fountain). */
  named_regions: string[];
  /** Tile ids that appear in the generated grid. */
  tile_types_present: string[];
  /** Biome defaults overlaid with the zone instance's spawn_weights. */
  spawn_weights: Record<string, number>;
  /** Feature operators available in this biome — id, one-line note, and whether
   *  the zone currently has it on. The model picks from these for zone_enhance. */
  available_features: Array<{ id: string; note: string; enabled: boolean }>;
  /** Count only — the model never sees the existing post_ops themselves. */
  existing_post_ops: number;
}

/** Capitalize a biome id for the display-name fallback (mirrors the client banner). */
function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Build the ZoneContext for a single zone id. Runs the generator to derive the
 * live region/tile sets. Pass a preloaded `world` to amortize the cost across
 * several zones in one Implementor run; otherwise the world is loaded fresh.
 *
 * Returns null when the zone id is unknown.
 */
export function buildZoneContext(zoneId: string, world?: WorldDefs): ZoneContext | null {
  const defs = world ?? loadWorld(join(REPO_ROOT, 'world'));
  const zone = defs.zones[zoneId];
  if (!zone) return null;

  const { bounds, grid } = generateZoneGrid(zone, defs.blockingTiles, defs.prefabs);

  const named_regions = Object.keys(bounds).sort();

  const tiles = new Set<string>();
  for (const row of grid) for (const t of row) tiles.add(t);

  const biomeDef = zone.biome ? BIOME_REGISTRY[zone.biome] : undefined;
  const spawn_weights = { ...(biomeDef?.spawnWeights ?? {}), ...(zone.spawn_weights ?? {}) };

  // Resolve the zone's active feature operators (biome defaults merged with the
  // zone's overrides). The array form (['beach_S']) means "on with defaults".
  const overrides = Array.isArray(zone.features)
    ? Object.fromEntries(zone.features.map((id) => [id, true as const]))
    : zone.features;
  const activeIds = new Set(mergeFeatures(biomeDef?.features ?? [], overrides).map((f) => f.id));

  // Available operators: the biome's defaults plus anything the zone added,
  // each with its registry note and current on/off state.
  const availIds = new Set<string>([...(biomeDef?.features ?? []).map((f) => f.id), ...activeIds]);
  const available_features = [...availIds].sort().map((id) => ({
    id,
    note: FEATURE_REGISTRY[id]?.note ?? '',
    enabled: activeIds.has(id),
  }));

  return {
    id: zone.id,
    biome: zone.biome ?? '',
    display_name: zone.display_name ?? zone.name ?? capitalize(zone.biome ?? zone.id),
    level_band: zone.level_band ?? null,
    connections: zone.connections ?? {},
    features: [...activeIds].sort(),
    named_regions,
    tile_types_present: [...tiles].sort(),
    spawn_weights,
    available_features,
    existing_post_ops: zone.post_ops?.length ?? 0,
  };
}

/** Format a ZoneContext as a compact prose block for the Implementor prompt. */
export function formatZoneContext(ctx: ZoneContext): string {
  const fmtWeights = (w: Record<string, number>): string => {
    const entries = Object.entries(w);
    return entries.length ? entries.map(([k, v]) => `${k}:${v}`).join(', ') : '(none)';
  };
  const lb = ctx.level_band
    ? `tier ${ctx.level_band.tier} (lvl ${ctx.level_band.minLevel}-${ctx.level_band.maxLevel})`
    : '(unset)';
  return [
    `### Zone context: ${ctx.id}`,
    `- display_name: ${ctx.display_name}`,
    `- biome: ${ctx.biome || '(none)'}`,
    `- level_band: ${lb}`,
    `- connections: ${Object.entries(ctx.connections).map(([d, z]) => `${d}→${z}`).join(', ') || '(none)'}`,
    `- active_features: ${ctx.features.join(', ') || '(none)'}`,
    `- named_regions: ${ctx.named_regions.join(', ') || '(none)'}`,
    `- tile_types_present: ${ctx.tile_types_present.join(', ') || '(none)'}`,
    `- spawn_weights: ${fmtWeights(ctx.spawn_weights)}`,
    `- available_features:${ctx.available_features.length ? '' : ' (none)'}`,
    ...ctx.available_features.map((f) => `    - ${f.id}${f.enabled ? ' (on)' : ''}: ${f.note}`),
    `- existing_post_ops: ${ctx.existing_post_ops}`,
  ].join('\n');
}
