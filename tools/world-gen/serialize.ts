// Serialize a generated WorldDef into the FORGE zone-graph schema
// (id/biome/seed/level_band/links/features). Shared by the export endpoint and
// the seed-regen script so they never drift.
//
// Terrain that worldgen decides — rivers and coastline — is emitted as zone
// `features` here, so it flows straight to the staged zone (rivers/beaches are
// land facts, not content the FORGE cascade generates).

import yaml from 'js-yaml';
import type { Direction, WorldBiome, WorldCell, WorldDef } from '../../shared/types.ts';
import { RIVER_CODES, BRIDGE_CODES } from '../../server/game/mapgen/features/river.ts';

// WorldBiome → zone biome key in BIOME_REGISTRY. ocean has no zone.
export const ZONE_BIOME_MAP: Partial<Record<WorldBiome, string>> = {
  forest: 'forest', grassland: 'grassland', plains: 'plains',
  tundra: 'tundra', desert: 'desert', swamp: 'swamp', mountain: 'mountain',
};

const EDGE_LETTER: Record<Direction, string> = { north: 'N', south: 'S', east: 'E', west: 'W' };
const DIRS: [Direction, number, number][] = [['north', 0, -1], ['south', 0, 1], ['west', -1, 0], ['east', 1, 0]];
const STRAIGHT = new Set<string>(BRIDGE_CODES); // codes that have a matching bridge

/** Match a cell's riverEdges to the river_* registry code (order-independent). */
function riverCode(edges: Direction[]): string | null {
  const letters = edges.map((e) => EDGE_LETTER[e]);
  return RIVER_CODES.find((c) => c.length === letters.length && letters.every((l) => c.includes(l))) ?? null;
}

export interface ZoneGraphEntry {
  id: string;
  biome: string;
  seed: string;
  level_band: WorldCell['levelBand'];
  links: string[];
  features?: string[];
}

export function worldToZoneGraph(world: WorldDef): { zones: ZoneGraphEntry[] } {
  const settlementAt = new Map<string, { type: string }>();
  for (const s of [...world.settlements, ...world.cities]) settlementAt.set(`${s.gridX}_${s.gridY}`, s);

  // Stable id per non-ocean cell so links can reference neighbours.
  const idAt = new Map<string, string>();
  for (const row of world.cells) {
    for (const c of row) {
      if (c.worldBiome === 'ocean') continue;
      const s = settlementAt.get(`${c.gridX}_${c.gridY}`);
      idAt.set(`${c.gridX}_${c.gridY}`, s ? `${s.type}_${c.gridX}_${c.gridY}` : `zone_${c.gridX}_${c.gridY}`);
    }
  }

  const zones: ZoneGraphEntry[] = [];
  for (const row of world.cells) {
    for (const cell of row) {
      if (cell.worldBiome === 'ocean') continue;
      const id = idAt.get(`${cell.gridX}_${cell.gridY}`)!;
      const settlement = settlementAt.get(`${cell.gridX}_${cell.gridY}`);
      const biome = settlement ? 'village' : (ZONE_BIOME_MAP[cell.worldBiome] ?? 'forest');

      const links: string[] = [];
      const features: string[] = [];
      for (const [dir, dx, dy] of DIRS) {
        const nid = idAt.get(`${cell.gridX + dx}_${cell.gridY + dy}`);
        if (nid) links.push(nid);
        else features.push(`beach_${EDGE_LETTER[dir]}`); // no land neighbour → ocean edge → beach
      }

      // Rivers: only straight (NS/EW) cells get water + a matching bridge, so a
      // river zone is always crossable. Bends/source/mouth are skipped for now
      // (no bend bridge yet) to guarantee traversability.
      if (cell.riverEdges?.length) {
        const code = riverCode(cell.riverEdges);
        if (code && STRAIGHT.has(code)) features.push(`river_${code}`, `bridge_${code}`);
      }

      zones.push({ id, biome, seed: cell.seed, level_band: cell.levelBand, links, ...(features.length ? { features } : {}) });
    }
  }
  return { zones };
}

export function worldToZoneGraphYaml(world: WorldDef): string {
  // flowLevel 3 keeps each zone entry on one compact line (matches the hand
  // seed's style) while leaving the top-level `zones:` list block-style.
  return yaml.dump(worldToZoneGraph(world), { lineWidth: -1, noRefs: true, flowLevel: 3 });
}
