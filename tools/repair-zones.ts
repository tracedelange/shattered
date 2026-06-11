// Runs the programmatic seed-retry repair on one or more existing zones.
// Unlike the implementer, this works on zones that already exist on disk.
//
//   npx tsx tools/repair-zones.ts village_41_41 zone_42_41
//   npx tsx tools/repair-zones.ts --all          # every zone in world/zones/

import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { loadWorld } from '../server/world/loader.ts';
import { repairZoneBySeedRetry } from '../pipeline/lib/zoneRepair.ts';

const ROOT  = join(import.meta.dirname, '..');
const WORLD = join(ROOT, 'world');

const args = process.argv.slice(2);
const allMode = args.includes('--all');

let zoneIds: string[];
if (allMode) {
  zoneIds = readdirSync(join(WORLD, 'zones'))
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
} else {
  zoneIds = args.filter(a => !a.startsWith('--'));
  if (zoneIds.length === 0) {
    console.error('Usage: npx tsx tools/repair-zones.ts <zoneId> [zoneId...]\n       npx tsx tools/repair-zones.ts --all');
    process.exit(1);
  }
}

const world = loadWorld(WORLD);
let changed = 0;

for (const zoneId of zoneIds) {
  if (!world.zones[zoneId]) {
    console.warn(`[repair-zones] ${zoneId}: not found in world — skipping`);
    continue;
  }
  try {
    const r = repairZoneBySeedRetry(zoneId, WORLD, world.tilesets, world.prefabs, 8);
    const suffix = `inaccessible=${r.inaccessibleTiles} accessible_default=${r.accessibleDefaultTiles} warnings=${r.warnings}`;
    if (r.reseeded || r.resized) {
      const what = [
        r.reseeded && `reseeded → ${r.seed}`,
        r.resized  && `resized → ${r.width ?? 'default'}x${r.height ?? 'default'}`,
      ].filter(Boolean).join(', ');
      console.log(`✓ ${zoneId}: ${what} after ${r.attempts} attempt(s)  [${suffix}]`);
      changed++;
    } else if (r.warnings > 0 || r.inaccessibleTiles > 0 || r.accessibleDefaultTiles > 0) {
      console.log(`~ ${zoneId}: kept ${r.seed} — no candidate was cleaner  [${suffix}]`);
    } else {
      console.log(`· ${zoneId}: already clean  [${suffix}]`);
    }
  } catch (err) {
    console.error(`✗ ${zoneId}: repair failed — ${(err as Error).message}`);
  }
}

console.log(`\n${changed} zone(s) updated.`);
