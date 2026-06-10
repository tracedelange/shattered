// CLI: render one zone (or all zones) to a PNG in world/renders/.
//
// Usage:
//   tsx pipeline/renderZone.ts <zone_id>           # one zone
//   tsx pipeline/renderZone.ts --all               # every zone
//   tsx pipeline/renderZone.ts <zone_id> --size=20 # custom tile size
//
// Prints the legend (regions, spawns, portals) to stdout. Useful as a
// stand-alone inspection tool and as the foundation for an LLM feedback loop.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorld } from '../server/world/loader.ts';
import { renderZoneToPNG, renderZoneToAscii, formatLegend } from './lib/renderZone.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const WORLD_DIR = join(ROOT, 'world');
const OUT_DIR   = join(WORLD_DIR, 'renders');

function parseArgs(argv: string[]): { zone?: string; all: boolean; tileSize: number; ascii: boolean } {
  let zone: string | undefined;
  let all = false;
  let tileSize = 14;
  let ascii = false;
  for (const a of argv) {
    if (a === '--all')   all = true;
    else if (a === '--ascii') ascii = true;
    else if (a.startsWith('--size=')) tileSize = Number(a.slice('--size='.length)) || 14;
    else if (!a.startsWith('--')) zone = a;
  }
  return { zone, all, tileSize, ascii };
}

function renderOne(
  zoneId: string,
  world: ReturnType<typeof loadWorld>,
  tileSize: number,
  ascii: boolean,
): void {
  const zoneDef = world.zones[zoneId];
  if (!zoneDef) {
    console.error(`[render] zone not found: ${zoneId}`);
    process.exit(1);
  }
  const tilesetName = (zoneDef as { tileset?: string }).tileset || 'overworld';
  const tileset = world.tilesets[tilesetName];
  if (!tileset) {
    console.error(`[render] tileset not found: ${tilesetName}`);
    process.exit(1);
  }

  const result = renderZoneToPNG(zoneDef, tileset, { tileSize, mobs: world.mobs, prefabs: world.prefabs });
  const outFile = join(OUT_DIR, `${zoneId}.png`);
  writeFileSync(outFile, result.png);

  console.log(formatLegend(zoneId, result));
  if (ascii) {
    const { text } = renderZoneToAscii(zoneDef, { tileset, prefabs: world.prefabs });
    console.log('\n' + text);
  }
  console.log(`\n  → ${outFile}`);
}

function main(): void {
  const { zone, all, tileSize, ascii } = parseArgs(process.argv.slice(2));
  if (!zone && !all) {
    console.error('Usage: tsx pipeline/renderZone.ts <zone_id> | --all  [--size=N] [--ascii]');
    process.exit(2);
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const world = loadWorld(WORLD_DIR);

  if (all) {
    for (const id of Object.keys(world.zones)) {
      renderOne(id, world, tileSize, ascii);
      console.log('---');
    }
  } else {
    renderOne(zone!, world, tileSize, ascii);
  }
}

main();
