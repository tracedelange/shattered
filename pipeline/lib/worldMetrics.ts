// World metrics — deterministic structural analysis of the zone graph.
//
// Computed fresh before every Gardener run so the LLM reasons from hard
// numbers rather than re-deriving them from raw YAML. The output is written
// to world/pipeline/world_metrics.yaml and injected as a dedicated context
// block in the Gardener prompt.
//
// Nothing here writes world files. It reads WorldDefs (already loaded by
// the pipeline), runs generateZoneGrid for walkability, and derives signals
// the Gardener should use to enforce constraints without guessing.

import { generateZoneGrid } from '../../server/game/mapgen/index.ts';
import { BLOCKING_TILES } from '../../shared/constants.ts';
import type { WorldDefs, ZoneDef } from '../../shared/types.ts';
import { MAX_BRANCHING_FACTOR } from './constants.ts';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ZoneMetrics {
  id: string;
  name: string;
  tileset: string;
  /** Tile dimensions declared in the YAML (or defaults). */
  width: number;
  height: number;
  /** Number of ops with type === 'region'. */
  region_count: number;
  /** Number of declared cardinal connections (north/south/east/west). */
  connection_degree: number;
  /** Zone IDs this zone connects to. */
  connected_to: string[];
  /** Number of portals. */
  portal_count: number;
  /** Number of spawn list entries (one entry may spawn multiple mobs). */
  spawn_entries: number;
  /** Sum of all spawn count values (approximation: count defaults to 1). */
  total_spawns: number;
  /** Distinct entity template IDs referenced in spawns. */
  unique_entities: string[];
  /** Non-blocking tiles in the generated grid. */
  walkable_tiles: number;
  /** Walkable tiles the player cannot reach from entry points. */
  inaccessible_tiles: number;
  /** Reachable tiles still on the default_tile — dungeon-carving bug indicator. */
  accessible_default_tiles: number;
  /** The zone's declared default_tile (or 'grass' if omitted). */
  default_tile: string;
  /** True when the raw YAML contains a lore_hook comment. */
  has_lore_hook: boolean;
}

export interface GraphMetrics {
  total_zones: number;
  /** Number of separate connected components in the undirected connection graph. */
  connected_components: number;
  /** Zone IDs with zero declared connections. */
  disconnected_zones: string[];
  /** Zone IDs with exactly 1 connection (leaf nodes). */
  dead_ends: string[];
  /** Zone IDs with MAX_BRANCHING_FACTOR or more connections. */
  high_degree_zones: string[];
  avg_connection_degree: number;
  max_connection_degree: number;
  /**
   * Neighbourhood clusters: groups of 2–5 mutually close zones (reachable
   * within 2 hops). Useful for identifying thematic pockets and expansion
   * opportunities. Each cluster lists its members and the hub (highest-degree
   * zone in the cluster, or the first alphabetically when tied).
   */
  clusters: Array<{ hub: string; members: string[] }>;
  /**
   * Zones that are structurally isolated from the main narrative path: dead
   * ends whose only neighbour is also a dead end, or single-connection zones
   * where the neighbour has connection_degree === 1. These are candidates for
   * add_connection or faction_presence opportunities.
   */
  narrative_orphans: string[];
}

export interface CompositionMetrics {
  avg_region_count: number;
  /** Count of zones with fewer than 3 named regions. */
  thin_zone_count: number;
  thin_zones: string[];
  tileset_distribution: Record<string, number>;
  default_tile_distribution: Record<string, number>;
  total_spawn_entries: number;
  avg_spawns_per_zone: number;
  zones_with_no_spawns: string[];
  unique_entity_count: number;
}

export interface GardenerSignals {
  /**
   * Zones that warrant a deepen_zone opportunity: fewer than 3 regions AND
   * at least 1 connection (players will actually visit them).
   */
  deepen_candidates: Array<{
    zone: string;
    region_count: number;
    connection_degree: number;
  }>;
  /**
   * Zones at the max branching factor (MAX_BRANCHING_FACTOR+). A new_zone opportunity must be
   * preceded by an add_connection refactor for these zones.
   */
  at_max_branching: string[];
  /** Zones with no spawn entries — likely feel empty. */
  no_spawn_zones: string[];
  /** Zones missing a lore_hook YAML comment. */
  no_lore_hook_zones: string[];
  /** Zones where the last grid analysis found inaccessible walkable tiles. */
  inaccessible_tile_zones: Array<{ zone: string; count: number }>;
  /** Zones where walkable default_tile is reachable (dungeon-carving bug). */
  accessible_default_zones: Array<{ zone: string; count: number; tile: string }>;
}

export interface WorldMetrics {
  generated_at: string;
  graph: GraphMetrics;
  composition: CompositionMetrics;
  signals: GardenerSignals;
  zones: ZoneMetrics[];
}

// ---------------------------------------------------------------------------
// Per-zone computation
// ---------------------------------------------------------------------------

function computeZoneMetrics(
  def: ZoneDef,
  rawYaml: string,
  blockingTiles: ReadonlySet<string>,
): ZoneMetrics {
  // Region count from ops list.
  const ops = def.ops ?? [];
  const regionCount = ops.filter((op) => op.type === 'region').length;

  // Connection graph degree.
  const connections = def.connections ?? {};
  const connectedTo = Object.values(connections).filter(Boolean) as string[];
  const connectionDegree = connectedTo.length;

  // Portals.
  const portals = def.portals ?? [];
  const portalCount = portals.length;

  // Spawns.
  const spawns = def.spawns ?? [];
  const spawnEntries = spawns.length;
  const totalSpawns = spawns.reduce((acc, s) => acc + (s.at ? 1 : (s.count ?? 1)), 0);
  const uniqueEntities = [...new Set(spawns.map((s) => s.entity))];

  // Lore hook — check for comment containing "lore" in the YAML source.
  const hasLoreHook = /^\s*#.*lore/im.test(rawYaml);

  // Grid analysis — run the mapgen to get actual tile data.
  const width  = def.width  ?? 40;
  const height = def.height ?? 30;
  const defaultTile = def.default_tile ?? 'grass';

  let walkableTiles = 0;
  let inaccessibleTiles = 0;
  let accessibleDefaultTiles = 0;

  try {
    const { grid } = generateZoneGrid(def, blockingTiles);

    // Count walkable tiles.
    for (const row of grid) {
      for (const tile of row) {
        if (!blockingTiles.has(tile)) walkableTiles++;
      }
    }

    // Seed BFS from all portal entry points + connected edge tiles.
    const seeds: Array<{ x: number; y: number }> = [];
    for (const p of portals) {
      if (p?.at) seeds.push(p.at);
    }
    const hasEdgeConnections = connectedTo.length > 0;
    if (hasEdgeConnections) {
      const dirs = Object.keys(connections) as Array<'north'|'south'|'east'|'west'>;
      for (const dir of dirs) {
        if (!connections[dir]) continue;
        if (dir === 'north') for (let x = 0; x < width; x++) seeds.push({ x, y: 0 });
        if (dir === 'south') for (let x = 0; x < width; x++) seeds.push({ x, y: height - 1 });
        if (dir === 'west')  for (let y = 0; y < height; y++) seeds.push({ x: 0, y });
        if (dir === 'east')  for (let y = 0; y < height; y++) seeds.push({ x: width - 1, y });
      }
    }

    const result = walkabilityBfs(grid, seeds, blockingTiles, hasEdgeConnections ? null : defaultTile);
    inaccessibleTiles = result.inaccessible;
    accessibleDefaultTiles = result.accessibleDefault;
  } catch {
    // If mapgen throws (malformed zone), leave counts at 0.
  }

  return {
    id: def.id,
    name: def.name ?? def.id,
    tileset: (def as { tileset?: string }).tileset ?? 'overworld',
    width,
    height,
    region_count: regionCount,
    connection_degree: connectionDegree,
    connected_to: connectedTo,
    portal_count: portalCount,
    spawn_entries: spawnEntries,
    total_spawns: totalSpawns,
    unique_entities: uniqueEntities,
    walkable_tiles: walkableTiles,
    inaccessible_tiles: inaccessibleTiles,
    accessible_default_tiles: accessibleDefaultTiles,
    default_tile: defaultTile,
    has_lore_hook: hasLoreHook,
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

  // Build walkable set.
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

  // Add valid seed positions.
  const validSeeds = seeds.filter((s) => {
    const k = s.y * w + s.x;
    return s.x >= 0 && s.x < w && s.y >= 0 && s.y < h && walkable.has(k);
  });

  if (validSeeds.length > 0) {
    for (const s of validSeeds) {
      const k = s.y * w + s.x;
      if (!visited.has(k)) { visited.add(k); queue.push(k); }
    }
  } else {
    // Fall back to first walkable tile.
    const first = walkable.values().next().value;
    if (first !== undefined) { visited.add(first); queue.push(first); }
  }

  const DIRS = [-w, w, -1, 1];
  let i = 0;
  while (i < queue.length) {
    const cur = queue[i++]!;
    const cy = Math.floor(cur / w);
    const cx = cur % w;
    for (const d of DIRS) {
      const nk = cur + d;
      if (d === -1 && cx === 0) continue;
      if (d ===  1 && cx === w - 1) continue;
      const ny = Math.floor(nk / w);
      if (ny < 0 || ny >= h) continue;
      if (!visited.has(nk) && walkable.has(nk)) { visited.add(nk); queue.push(nk); }
    }
  }

  const inaccessible = walkable.size - visited.size;

  let accessibleDefault = 0;
  if (defaultTile !== null && !blockingTiles.has(defaultTile)) {
    for (const k of visited) {
      const y = Math.floor(k / w);
      const x = k % w;
      if (grid[y]?.[x] === defaultTile) accessibleDefault++;
    }
  }

  return { inaccessible, accessibleDefault };
}

// ---------------------------------------------------------------------------
// Graph metrics
// ---------------------------------------------------------------------------

function computeGraphMetrics(zones: ZoneMetrics[]): GraphMetrics {
  const ids = new Set(zones.map((z) => z.id));

  // Build undirected adjacency list (only edges within the known zone set).
  const adj = new Map<string, Set<string>>();
  for (const z of zones) {
    if (!adj.has(z.id)) adj.set(z.id, new Set());
    for (const neighbour of z.connected_to) {
      if (!ids.has(neighbour)) continue;
      adj.get(z.id)!.add(neighbour);
      if (!adj.has(neighbour)) adj.set(neighbour, new Set());
      adj.get(neighbour)!.add(z.id);
    }
  }

  // BFS to count connected components.
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

  const degrees = zones.map((z) => z.connection_degree);
  const avgDegree = degrees.length ? degrees.reduce((a, b) => a + b, 0) / degrees.length : 0;
  const maxDegree = degrees.length ? Math.max(...degrees) : 0;

  // ---------------------------------------------------------------------------
  // Neighbourhood clusters: identify groups of 2–5 zones that are mutually
  // reachable within 2 hops. Algorithm: for each high-degree zone (hub), BFS
  // up to depth 2 and record the reachable set. Deduplicate clusters whose
  // member sets are subsets of a larger cluster.
  // ---------------------------------------------------------------------------
  const degreeMap = new Map(zones.map((z) => [z.id, z.connection_degree]));

  // BFS to depth `maxDepth` from `start`; returns the set of reachable zone IDs.
  function bfsDepth(start: string, maxDepth: number): Set<string> {
    const visited = new Set<string>([start]);
    let frontier = [start];
    for (let d = 0; d < maxDepth; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of (adj.get(id) ?? [])) {
          if (!visited.has(nb)) { visited.add(nb); next.push(nb); }
        }
      }
      frontier = next;
    }
    return visited;
  }

  // Seed clusters from zones with degree >= 2 (actual hubs).
  const rawClusters: Array<{ hub: string; members: Set<string> }> = [];
  for (const z of zones) {
    if (z.connection_degree < 2) continue;
    const members = bfsDepth(z.id, 2);
    if (members.size >= 2) rawClusters.push({ hub: z.id, members });
  }

  // Deduplicate: remove clusters that are strict subsets of another cluster.
  const clusters: Array<{ hub: string; members: string[] }> = [];
  for (let i = 0; i < rawClusters.length; i++) {
    const a = rawClusters[i]!;
    const dominated = rawClusters.some((b, j) => {
      if (i === j) return false;
      if (b.members.size <= a.members.size) return false;
      return [...a.members].every((id) => b.members.has(id));
    });
    if (!dominated) {
      // Hub = highest-degree member; tie-break alphabetically.
      const sorted = [...a.members].sort((x, y) => {
        const dx = degreeMap.get(x) ?? 0;
        const dy = degreeMap.get(y) ?? 0;
        return dy !== dx ? dy - dx : x.localeCompare(y);
      });
      clusters.push({ hub: sorted[0]!, members: sorted });
    }
  }

  // ---------------------------------------------------------------------------
  // Narrative orphans: dead ends whose single neighbour is also a dead end.
  // These form dangling pairs with no path back to the main graph short of
  // going through the pair itself — lowest narrative connectivity.
  // ---------------------------------------------------------------------------
  const deadEndSet = new Set(zones.filter((z) => z.connection_degree === 1).map((z) => z.id));
  const narrativeOrphans = zones
    .filter((z) => {
      if (!deadEndSet.has(z.id)) return false;
      const neighbours = [...(adj.get(z.id) ?? [])];
      return neighbours.every((nb) => deadEndSet.has(nb));
    })
    .map((z) => z.id);

  return {
    total_zones: zones.length,
    connected_components: components,
    disconnected_zones: zones.filter((z) => z.connection_degree === 0).map((z) => z.id),
    dead_ends: zones.filter((z) => z.connection_degree === 1).map((z) => z.id),
    high_degree_zones: zones.filter((z) => z.connection_degree >= MAX_BRANCHING_FACTOR).map((z) => z.id),
    avg_connection_degree: Math.round(avgDegree * 100) / 100,
    max_connection_degree: maxDegree,
    clusters,
    narrative_orphans: narrativeOrphans,
  };
}

// ---------------------------------------------------------------------------
// Composition metrics
// ---------------------------------------------------------------------------

function computeCompositionMetrics(zones: ZoneMetrics[]): CompositionMetrics {
  const avgRegions = zones.length
    ? zones.reduce((a, z) => a + z.region_count, 0) / zones.length
    : 0;

  const tilesetDist: Record<string, number> = {};
  const defaultTileDist: Record<string, number> = {};
  for (const z of zones) {
    tilesetDist[z.tileset] = (tilesetDist[z.tileset] ?? 0) + 1;
    defaultTileDist[z.default_tile] = (defaultTileDist[z.default_tile] ?? 0) + 1;
  }

  const allEntities = new Set(zones.flatMap((z) => z.unique_entities));
  const thinZones = zones.filter((z) => z.region_count < 3);
  const totalSpawnEntries = zones.reduce((a, z) => a + z.spawn_entries, 0);

  return {
    avg_region_count: Math.round(avgRegions * 100) / 100,
    thin_zone_count: thinZones.length,
    thin_zones: thinZones.map((z) => z.id),
    tileset_distribution: tilesetDist,
    default_tile_distribution: defaultTileDist,
    total_spawn_entries: totalSpawnEntries,
    avg_spawns_per_zone: zones.length
      ? Math.round((totalSpawnEntries / zones.length) * 100) / 100
      : 0,
    zones_with_no_spawns: zones.filter((z) => z.spawn_entries === 0).map((z) => z.id),
    unique_entity_count: allEntities.size,
  };
}

// ---------------------------------------------------------------------------
// Gardener signals
// ---------------------------------------------------------------------------

function computeSignals(zones: ZoneMetrics[]): GardenerSignals {
  return {
    deepen_candidates: zones
      .filter((z) => z.region_count < 3 && z.connection_degree >= 1)
      .map((z) => ({
        zone: z.id,
        region_count: z.region_count,
        connection_degree: z.connection_degree,
      })),
    at_max_branching: zones
      .filter((z) => z.connection_degree >= MAX_BRANCHING_FACTOR)
      .map((z) => z.id),
    no_spawn_zones: zones
      .filter((z) => z.spawn_entries === 0)
      .map((z) => z.id),
    no_lore_hook_zones: zones
      .filter((z) => !z.has_lore_hook)
      .map((z) => z.id),
    inaccessible_tile_zones: zones
      .filter((z) => z.inaccessible_tiles > 0)
      .map((z) => ({ zone: z.id, count: z.inaccessible_tiles })),
    accessible_default_zones: zones
      .filter((z) => z.accessible_default_tiles > 0)
      .map((z) => ({
        zone: z.id,
        count: z.accessible_default_tiles,
        tile: z.default_tile,
      })),
  };
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Compute a full WorldMetrics snapshot from loaded world definitions and the
 * raw YAML source strings (needed for lore_hook comment detection).
 *
 * @param defs       Parsed WorldDefs (from loadWorld).
 * @param rawZones   Raw YAML text keyed by zone id (from the pipeline bundle).
 */
export function computeWorldMetrics(
  defs: WorldDefs,
  rawZones: Array<{ id: string; body: string }>,
): WorldMetrics {
  const blockingTiles = defs.blockingTiles ?? BLOCKING_TILES;

  // Build a map for fast raw body lookup.
  const rawMap = new Map(rawZones.map((z) => [z.id, z.body]));

  const zoneMetrics = Object.values(defs.zones).map((def) =>
    computeZoneMetrics(def, rawMap.get(def.id) ?? '', blockingTiles),
  );

  const graph = computeGraphMetrics(zoneMetrics);
  const composition = computeCompositionMetrics(zoneMetrics);
  const signals = computeSignals(zoneMetrics);

  return {
    generated_at: new Date().toISOString(),
    graph,
    composition,
    signals,
    zones: zoneMetrics,
  };
}
