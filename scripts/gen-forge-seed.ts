// Regenerate forge/seeds/zone_graph.yaml from worldgen with rivers + varied
// biomes. Searches seeds for a world that has a bridgeable river, biome variety,
// and a low-tier village (so the start isn't endgame), then writes the graph.
//
//   npx tsx scripts/gen-forge-seed.ts [seed]
//
// Pass a seed to force it; omit to auto-pick the best of a search.

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateWorld, type WorldGenParams } from '../server/game/mapgen/worldgen.ts';
import { worldToZoneGraph, worldToZoneGraphYaml } from '../tools/world-gen/serialize.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'forge', 'seeds', 'zone_graph.yaml');

// Compact region with a clean north=dangerous gradient (progression SN).
const BASE: Omit<WorldGenParams, 'seed'> = {
  cols: 8, rows: 9, progressionMode: 'linear', progressionDir: 'SN',
};

interface Score { biomes: number; riverZones: number; lowTierVillage: boolean; land: number; total: number }

function score(seed: string): Score {
  const world = generateWorld({ ...BASE, seed });
  const { zones } = worldToZoneGraph(world);
  const biomes = new Set(zones.map((z) => z.biome));
  const riverZones = zones.filter((z) => z.features?.some((f) => f.startsWith('river_'))).length;
  // a village whose level band is tier ≤ 2 makes a sane starting area
  const lowTierVillage = zones.some((z) => z.biome === 'village' && z.level_band.tier <= 2);
  const total = biomes.size * 2 + (riverZones > 0 ? 4 : 0) + (lowTierVillage ? 4 : 0) + Math.min(zones.length, 50) * 0.05;
  return { biomes: biomes.size, riverZones, lowTierVillage, land: zones.length, total };
}

function main(): void {
  const forced = process.argv[2];
  let chosen = forced;
  if (!chosen) {
    let best = { seed: '', s: { total: -1 } as Score };
    for (let i = 0; i < 60; i++) {
      const seed = `keen-${i}`;
      const s = score(seed);
      if (s.total > best.s.total) best = { seed, s };
    }
    chosen = best.seed;
    console.log(`[gen] picked seed "${chosen}":`, JSON.stringify(best.s));
  }

  const world = generateWorld({ ...BASE, seed: chosen });
  const { zones } = worldToZoneGraph(world);
  writeFileSync(OUT, worldToZoneGraphYaml(world), 'utf8');

  // Report
  const biomes: Record<string, number> = {};
  for (const z of zones) biomes[z.biome] = (biomes[z.biome] ?? 0) + 1;
  const rivers = zones.filter((z) => z.features?.some((f) => f.startsWith('river_'))).map((z) => z.id);
  const villages = zones.filter((z) => z.biome === 'village').map((z) => `${z.id}(t${z.level_band.tier})`);
  console.log(`[gen] wrote ${zones.length} zones → forge/seeds/zone_graph.yaml`);
  console.log('[gen] biomes:', JSON.stringify(biomes));
  console.log('[gen] river zones:', rivers.join(', ') || '(none)');
  console.log('[gen] villages:', villages.join(', ') || '(none)');
}

main();
