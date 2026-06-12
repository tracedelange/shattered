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
  /** Feature operators available in this biome — id, one-line note, and whether
   *  the zone currently has it on. The model picks from these for zone_enhance. */
  available_features: Array<{ id: string; note: string; enabled: boolean }>;
  /** Count only — the model never sees the existing post_ops themselves. */
  existing_post_ops: number;
  /** Entities already spawned here (zone file + biome defaults merged), aggregated
   *  by template. Lets the model avoid re-adding an NPC that already exists. */
  existing_spawns: Array<{ entity: string; count: number }>;
  /** Quests already given in this zone, with their giver. Surfaces giver overload
   *  (e.g. a notice board already carrying 16 quests) so the model spreads load. */
  existing_quests: Array<{ id: string; giver: string }>;
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

  // Existing inhabitants — zone.spawns is already merged with biome defaultSpawns
  // by the loader (resolveBiomeOps), so this reflects what actually spawns in-game.
  const spawnByEntity = new Map<string, number>();
  for (const s of zone.spawns ?? []) {
    const c = s.at ? 1 : (s.count ?? 1);
    spawnByEntity.set(s.entity, (spawnByEntity.get(s.entity) ?? 0) + c);
  }
  const existing_spawns = [...spawnByEntity]
    .map(([entity, count]) => ({ entity, count }))
    .sort((a, b) => a.entity.localeCompare(b.entity));

  // Quests already given in this zone (giver lives here).
  const existing_quests = Object.values(defs.quests)
    .filter((q) => q.zone === zoneId)
    .map((q) => ({ id: q.id, giver: typeof q.giver === 'string' ? q.giver : '(none)' }))
    .sort((a, b) => a.giver.localeCompare(b.giver) || a.id.localeCompare(b.id));

  const biomeDef = zone.biome ? BIOME_REGISTRY[zone.biome] : undefined;

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
    available_features,
    existing_post_ops: zone.post_ops?.length ?? 0,
    existing_spawns,
    existing_quests,
  };
}

/** Format a ZoneContext as a compact prose block for the Implementor prompt. */
export function formatZoneContext(ctx: ZoneContext): string {
  const lb = ctx.level_band
    ? `tier ${ctx.level_band.tier} (lvl ${ctx.level_band.minLevel}-${ctx.level_band.maxLevel})`
    : '(unset)';
  // Group existing quests by giver so an overloaded NPC is visible at a glance.
  const questsByGiver: Record<string, string[]> = {};
  for (const q of ctx.existing_quests) (questsByGiver[q.giver] ??= []).push(q.id);
  return [
    `### Zone context: ${ctx.id}`,
    `- display_name: ${ctx.display_name}`,
    `- biome: ${ctx.biome || '(none)'}`,
    `- level_band: ${lb}`,
    `- connections: ${Object.entries(ctx.connections).map(([d, z]) => `${d}→${z}`).join(', ') || '(none)'}`,
    `- active_features: ${ctx.features.join(', ') || '(none)'}`,
    `- named_regions: ${ctx.named_regions.join(', ') || '(none)'}`,
    `- tile_types_present: ${ctx.tile_types_present.join(', ') || '(none)'}`,
    `- available_features:${ctx.available_features.length ? '' : ' (none)'}`,
    ...ctx.available_features.map((f) => `    - ${f.id}${f.enabled ? ' (on)' : ''}: ${f.note}`),
    `- existing_post_ops: ${ctx.existing_post_ops}`,
    `- existing_spawns: ${ctx.existing_spawns.map((s) => `${s.entity}×${s.count}`).join(', ') || '(none)'}`,
    `  (do NOT re-add an NPC already listed here — reuse it as a giver instead)`,
    `- existing_quests: ${ctx.existing_quests.length === 0 ? '(none)' : `${ctx.existing_quests.length} total`}`,
    ...Object.entries(questsByGiver).map(([g, ids]) => `    - ${g} (${ids.length}): ${ids.join(', ')}`),
  ].join('\n');
}
