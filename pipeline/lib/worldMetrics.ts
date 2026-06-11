// World metrics — deterministic structural analysis for the v2 stub world.
//
// The world's terrain and cardinal connection graph are frozen worldgen
// output; development means INDIVIDUALIZATION (spawns, identity, quests,
// sub-zones). The metrics therefore measure development, not geometry:
// every zone gets a depth-ladder score, and the signals point the Gardener
// at the frontier — developed zones bordering undeveloped ones.
//
// Grid/walkability analysis (the expensive part: it runs the full mapgen) is
// scoped to zones that have actually been individualized plus any caller-
// supplied focus set; pristine stubs are deterministic worldgen output and
// re-checking thousands of them is pure waste.
//
// Nothing here writes world files. The Gardener serializes a trimmed view to
// world/pipeline/world_metrics.yaml for inspection between runs.

import { generateZoneGrid } from '../../server/game/mapgen/index.ts';
import { BLOCKING_TILES } from '../../shared/constants.ts';
import type { WorldDefs, ZoneDef } from '../../shared/types.ts';

const CARDINALS = new Set(['north', 'south', 'east', 'west']);

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ZoneMetrics {
  id: string;
  biome: string | null;
  /** Player-facing name, null when the zone is still unnamed (rung-2 gap). */
  display_name: string | null;
  /** Cardinal connection count (frozen worldgen graph). */
  connection_degree: number;
  /** Zone IDs this zone connects to (cardinal only). */
  connected_to: string[];
  /** Parent zone when this is a sub-zone (non-cardinal connection out). */
  parent_zone: string | null;
  /** Number of spawn list entries (one entry may spawn multiple mobs). */
  spawn_entries: number;
  /** Sum of all spawn count values (count defaults to 1). */
  total_spawns: number;
  /** Distinct entity template IDs referenced in spawns. */
  unique_entities: string[];
  /** Implementor-appended post_ops on this zone. */
  post_ops: number;
  /** Quests whose giver lives in this zone. */
  quests: number;
  /** Sub-zones hanging off this zone via a non-cardinal connection. */
  subzones: string[];
  /**
   * Depth-ladder score 0–4: +1 inhabitants (total_spawns > 0),
   * +1 identity (display_name set), +1 purpose (quests > 0),
   * +1 depth (subzones present).
   */
  development: number;
  /** True when the expensive grid analysis ran for this zone. */
  grid_analyzed: boolean;
  /** Non-blocking tiles in the generated grid (0 when not analyzed). */
  walkable_tiles: number;
  /** Walkable tiles the player cannot reach from entry points. */
  inaccessible_tiles: number;
  /** Reachable tiles still on the default_tile — dungeon-carving bug indicator. */
  accessible_default_tiles: number;
  /** The zone's resolved default_tile (or 'grass' if omitted). */
  default_tile: string;
}

export interface GraphMetrics {
  total_zones: number;
  /** Separate connected components in the undirected cardinal graph. */
  connected_components: number;
  /** Zone IDs with zero connections of any kind. */
  disconnected_zones: string[];
}

export interface CompositionMetrics {
  /** Zone count per biome. */
  biome_distribution: Record<string, number>;
  /** Zone count per development score (0–4). */
  development_distribution: Record<number, number>;
  zones_with_spawns: number;
  total_spawn_entries: number;
  unique_entity_count: number;
  quest_count: number;
}

export interface FrontierEntry {
  zone: string;
  development: number;
  /** Adjacent zones with development 0 — the natural expansion surface. */
  undeveloped_neighbors: string[];
}

export interface GardenerSignals {
  /**
   * Developed zones bordering undeveloped ones, most developed first.
   * Content radiates outward: the next mob_populate / zone_enhance belongs
   * on one of these borders.
   */
  frontier: FrontierEntry[];
  /** Zones with inhabitants but no display_name — rung-2 candidates. */
  unnamed_inhabited_zones: string[];
  /** Settlement zones with no quest giver — rung-3 candidates. */
  questless_settlements: string[];
  /** Analyzed zones with unreachable walkable tiles (structural repair). */
  inaccessible_tile_zones: Array<{ zone: string; count: number }>;
  /** Analyzed zones where a walkable default_tile is reachable (carving bug). */
  accessible_default_zones: Array<{ zone: string; count: number; tile: string }>;
}

export interface WorldMetrics {
  generated_at: string;
  graph: GraphMetrics;
  composition: CompositionMetrics;
  signals: GardenerSignals;
  zones: ZoneMetrics[];
}

/** True when the zone is a settlement (anchor candidate for development). */
export function isSettlement(def: ZoneDef): boolean {
  return def.biome === 'village' || /^(village|city)_/.test(def.id);
}

/** True when a zone has been individualized beyond the worldgen stub. */
function isDeveloped(def: ZoneDef): boolean {
  return (
    (def.post_ops?.length ?? 0) > 0 ||
    (def.spawns?.length ?? 0) > 0 ||
    !!def.name
  );
}

// ---------------------------------------------------------------------------
// Per-zone computation
// ---------------------------------------------------------------------------

function computeZoneMetrics(
  def: ZoneDef,
  defs: WorldDefs,
  questsByZone: Map<string, number>,
  subzonesByParent: Map<string, string[]>,
  analyzeGrid: boolean,
): ZoneMetrics {
  const connections = def.connections ?? {};
  const cardinalTargets = Object.entries(connections)
    .filter(([dir, target]) => CARDINALS.has(dir) && target)
    .map(([, target]) => target as string);
  const parentZone = Object.entries(connections)
    .find(([dir, target]) => !CARDINALS.has(dir) && target)?.[1] ?? null;

  const spawns = def.spawns ?? [];
  const totalSpawns = spawns.reduce((acc, s) => acc + (s.at ? 1 : (s.count ?? 1)), 0);
  const uniqueEntities = [...new Set(spawns.map((s) => s.entity))];
  const quests = questsByZone.get(def.id) ?? 0;
  const subzones = subzonesByParent.get(def.id) ?? [];

  const development =
    (totalSpawns > 0 ? 1 : 0) +
    (def.name ? 1 : 0) +
    (quests > 0 ? 1 : 0) +
    (subzones.length > 0 ? 1 : 0);

  const defaultTile = def.default_tile ?? 'grass';
  let walkableTiles = 0;
  let inaccessibleTiles = 0;
  let accessibleDefaultTiles = 0;

  if (analyzeGrid) try {
    const blockingTiles = defs.blockingTiles ?? BLOCKING_TILES;
    const { grid } = generateZoneGrid(def, blockingTiles, defs.prefabs);
    const width = grid[0]?.length ?? 0;
    const height = grid.length;

    for (const row of grid) {
      for (const tile of row) {
        if (!blockingTiles.has(tile)) walkableTiles++;
      }
    }

    // Seed BFS from portal entry points + connected cardinal edges.
    const seeds: Array<{ x: number; y: number }> = [];
    for (const p of def.portals ?? []) {
      if (p?.at) seeds.push(p.at);
    }
    const hasEdgeConnections = cardinalTargets.length > 0;
    for (const dir of CARDINALS) {
      if (!connections[dir]) continue;
      if (dir === 'north') for (let x = 0; x < width; x++) seeds.push({ x, y: 0 });
      if (dir === 'south') for (let x = 0; x < width; x++) seeds.push({ x, y: height - 1 });
      if (dir === 'west')  for (let y = 0; y < height; y++) seeds.push({ x: 0, y });
      if (dir === 'east')  for (let y = 0; y < height; y++) seeds.push({ x: width - 1, y });
    }

    const result = walkabilityBfs(grid, seeds, defs.blockingTiles ?? BLOCKING_TILES, hasEdgeConnections ? null : defaultTile);
    inaccessibleTiles = result.inaccessible;
    accessibleDefaultTiles = result.accessibleDefault;
  } catch {
    // If mapgen throws (malformed zone), leave counts at 0.
  }

  return {
    id: def.id,
    biome: def.biome ?? null,
    display_name: def.name ?? null,
    connection_degree: cardinalTargets.length,
    connected_to: cardinalTargets,
    parent_zone: parentZone,
    spawn_entries: spawns.length,
    total_spawns: totalSpawns,
    unique_entities: uniqueEntities,
    post_ops: def.post_ops?.length ?? 0,
    quests,
    subzones,
    development,
    grid_analyzed: analyzeGrid,
    walkable_tiles: walkableTiles,
    inaccessible_tiles: inaccessibleTiles,
    accessible_default_tiles: accessibleDefaultTiles,
    default_tile: defaultTile,
  };
}

// Minimal BFS for walkability — avoids importing renderZone just for its BFS.
function walkabilityBfs(
  grid: string[][],
  seeds: Array<{ x: number; y: number }>,
  blockingTiles: ReadonlySet<string>,
  defaultTile: string | null,
): { inaccessible: number; accessibleDefault: number } {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;

  const walkable = new Set<number>();
  for (let y = 0; y < h; y++) {
    const row = grid[y]!;
    for (let x = 0; x < w; x++) {
      if (!blockingTiles.has(row[x]!)) walkable.add(y * w + x);
    }
  }
  if (walkable.size === 0) return { inaccessible: 0, accessibleDefault: 0 };

  const visited = new Set<number>();
  const queue: number[] = [];
  for (const s of seeds) {
    const key = s.y * w + s.x;
    if (walkable.has(key) && !visited.has(key)) {
      visited.add(key);
      queue.push(key);
    }
  }
  // Fall back to the first walkable tile when no seed landed on one.
  if (queue.length === 0) {
    const first = walkable.values().next().value as number;
    visited.add(first);
    queue.push(first);
  }

  let qi = 0;
  while (qi < queue.length) {
    const key = queue[qi++]!;
    const x = key % w;
    const y = (key - x) / w;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nk = ny * w + nx;
      if (walkable.has(nk) && !visited.has(nk)) {
        visited.add(nk);
        queue.push(nk);
      }
    }
  }

  let inaccessible = 0;
  for (const key of walkable) {
    if (!visited.has(key)) inaccessible++;
  }

  let accessibleDefault = 0;
  if (defaultTile !== null && !blockingTiles.has(defaultTile)) {
    for (const key of visited) {
      const x = key % w;
      const y = (key - x) / w;
      if (grid[y]![x] === defaultTile) accessibleDefault++;
    }
  }
  return { inaccessible, accessibleDefault };
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

function computeGraphMetrics(zones: ZoneMetrics[]): GraphMetrics {
  const ids = new Set(zones.map((z) => z.id));
  const adj = new Map<string, Set<string>>();
  for (const z of zones) {
    if (!adj.has(z.id)) adj.set(z.id, new Set());
    // Sub-zone (parent) links count as edges: a cellar reached by portal is
    // part of its parent's component, not an island.
    const neighbours = [...z.connected_to, ...(z.parent_zone ? [z.parent_zone] : [])];
    for (const neighbour of neighbours) {
      if (!ids.has(neighbour)) continue;
      adj.get(z.id)!.add(neighbour);
      if (!adj.has(neighbour)) adj.set(neighbour, new Set());
      adj.get(neighbour)!.add(z.id);
    }
  }

  const seen = new Set<string>();
  let components = 0;
  for (const id of ids) {
    if (seen.has(id)) continue;
    components++;
    const q = [id];
    seen.add(id);
    let qi = 0;
    while (qi < q.length) {
      for (const nb of (adj.get(q[qi++]!) ?? [])) {
        if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
      }
    }
  }

  return {
    total_zones: zones.length,
    connected_components: components,
    disconnected_zones: zones
      .filter((z) => z.connection_degree === 0 && !z.parent_zone && z.subzones.length === 0)
      .map((z) => z.id),
  };
}

function computeCompositionMetrics(zones: ZoneMetrics[], questCount: number): CompositionMetrics {
  const biomeDist: Record<string, number> = {};
  const devDist: Record<number, number> = {};
  for (const z of zones) {
    const b = z.biome ?? '(none)';
    biomeDist[b] = (biomeDist[b] ?? 0) + 1;
    devDist[z.development] = (devDist[z.development] ?? 0) + 1;
  }
  return {
    biome_distribution: biomeDist,
    development_distribution: devDist,
    zones_with_spawns: zones.filter((z) => z.total_spawns > 0).length,
    total_spawn_entries: zones.reduce((a, z) => a + z.spawn_entries, 0),
    unique_entity_count: new Set(zones.flatMap((z) => z.unique_entities)).size,
    quest_count: questCount,
  };
}

function computeSignals(zones: ZoneMetrics[], defs: WorldDefs): GardenerSignals {
  const byId = new Map(zones.map((z) => [z.id, z]));

  const frontier: FrontierEntry[] = zones
    .filter((z) => z.development > 0)
    .map((z) => ({
      zone: z.id,
      development: z.development,
      undeveloped_neighbors: z.connected_to.filter((n) => (byId.get(n)?.development ?? 0) === 0),
    }))
    .filter((f) => f.undeveloped_neighbors.length > 0)
    .sort((a, b) => b.development - a.development || a.zone.localeCompare(b.zone));

  return {
    frontier,
    unnamed_inhabited_zones: zones
      .filter((z) => z.total_spawns > 0 && !z.display_name)
      .map((z) => z.id),
    questless_settlements: zones
      .filter((z) => z.quests === 0 && defs.zones[z.id] && isSettlement(defs.zones[z.id]!))
      .map((z) => z.id),
    inaccessible_tile_zones: zones
      .filter((z) => z.grid_analyzed && z.inaccessible_tiles > 0)
      .map((z) => ({ zone: z.id, count: z.inaccessible_tiles })),
    accessible_default_zones: zones
      .filter((z) => z.grid_analyzed && z.accessible_default_tiles > 0)
      .map((z) => ({ zone: z.id, count: z.accessible_default_tiles, tile: z.default_tile })),
  };
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Compute a WorldMetrics snapshot from loaded world definitions.
 *
 * Grid/walkability analysis runs for developed zones (post_ops, spawns, or a
 * display_name — i.e. zones the pipeline has touched) plus everything in
 * `gridFocus`. Pristine stubs get cheap structural rows only: their grids are
 * deterministic worldgen output and re-validating thousands of them per run
 * is waste.
 *
 * @param defs       Parsed WorldDefs (from loadWorld).
 * @param gridFocus  Extra zone IDs to grid-analyze (e.g. the anchor
 *                   neighborhood or an opportunity's ring).
 */
export function computeWorldMetrics(
  defs: WorldDefs,
  gridFocus?: Set<string>,
): WorldMetrics {
  // Sub-zone index: child zones declare a non-cardinal connection to a parent.
  const subzonesByParent = new Map<string, string[]>();
  for (const def of Object.values(defs.zones)) {
    for (const [dir, target] of Object.entries(def.connections ?? {})) {
      if (CARDINALS.has(dir) || !target) continue;
      subzonesByParent.set(target, [...(subzonesByParent.get(target) ?? []), def.id]);
    }
  }

  // Quest-giver index.
  const questsByZone = new Map<string, number>();
  for (const q of Object.values(defs.quests)) {
    if (q.zone) questsByZone.set(q.zone, (questsByZone.get(q.zone) ?? 0) + 1);
  }

  const zoneMetrics = Object.values(defs.zones).map((def) =>
    computeZoneMetrics(
      def, defs, questsByZone, subzonesByParent,
      isDeveloped(def) || (gridFocus?.has(def.id) ?? false),
    ),
  );

  return {
    generated_at: new Date().toISOString(),
    graph: computeGraphMetrics(zoneMetrics),
    composition: computeCompositionMetrics(zoneMetrics, Object.keys(defs.quests).length),
    signals: computeSignals(zoneMetrics, defs),
    zones: zoneMetrics,
  };
}

/**
 * Trimmed view for world/pipeline/world_metrics.yaml: aggregates + signals in
 * full, per-zone rows only for zones that are developed or flagged. On a
 * large stub world the full row set is megabytes of noise.
 */
export function trimMetricsForDisk(metrics: WorldMetrics): Omit<WorldMetrics, 'zones'> & {
  zones: ZoneMetrics[];
  zones_note: string;
} {
  const flagged = new Set<string>([
    ...metrics.signals.frontier.map((f) => f.zone),
    ...metrics.signals.inaccessible_tile_zones.map((d) => d.zone),
    ...metrics.signals.accessible_default_zones.map((d) => d.zone),
  ]);
  const rows = metrics.zones.filter((z) => z.development > 0 || flagged.has(z.id));
  return {
    ...metrics,
    zones: rows,
    zones_note: `${metrics.zones.length} zones total; rows shown only for the ${rows.length} developed/flagged.`,
  };
}
