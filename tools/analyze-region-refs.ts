// One-off: quantify Class A (region-not-defined) post_op failures across world/zones.
// For each zone, derive the live region set (same path as the implementer context)
// and check every region reference in its post_ops against that set.

import { join } from 'node:path';
import { loadWorld } from '../server/world/loader.ts';
import { buildZoneContext } from '../pipeline/lib/context.ts';
import { REPO_ROOT } from '../pipeline/lib/io.ts';

// Field names in a post_op (or nested at/bounds/point ref) that name an EXISTING region.
// `region:` itself is a WRITE (creates a region) so it is excluded.
const REF_FIELDS = ['in_region', 'center_of_region', 'near_region', 'relative_to', 'if_region'];

// Walk a value tree, collecting region-id strings from known ref fields and from
// point/bounds refs of the shape { region: "<id>", ... }.
function collectRefs(node: unknown, out: Set<string>, isWriteContext = false): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const v of node) collectRefs(v, out); return; }
  const obj = node as Record<string, unknown>;
  for (const f of REF_FIELDS) {
    if (typeof obj[f] === 'string') out.add(obj[f] as string);
  }
  // Point/bounds ref: { region: "x" } resolving an existing region. But a top-level
  // op `region: "x"` is a write. Heuristic: treat `region` as a ref only when the
  // object also carries an `anchor` (point ref) or is inside an `at`/`bounds`/`from`/`to`.
  if (typeof obj.region === 'string' && ('anchor' in obj)) out.add(obj.region as string);
  // Recurse into nested ref-bearing keys.
  for (const k of ['at', 'bounds', 'from', 'to']) {
    if (obj[k] && typeof obj[k] === 'object') {
      const sub = obj[k] as Record<string, unknown>;
      if (typeof sub.region === 'string') out.add(sub.region as string);
      collectRefs(sub, out);
    }
  }
}

const defs = loadWorld(join(REPO_ROOT, 'world'));
const zoneIds = Object.keys(defs.zones);

let zonesWithPostOps = 0;
let zonesWithRefs = 0;
let zonesWithMissingRefs = 0;
let totalRefs = 0;
let totalMissing = 0;
const missingByRef = new Map<string, number>(); // ref id -> count of zones missing it
const sampleZones: string[] = [];

let i = 0;
for (const zid of zoneIds) {
  i++;
  if (i % 200 === 0) process.stderr.write(`  ...${i}/${zoneIds.length}\n`);
  const zone = defs.zones[zid];
  const postOps = zone.post_ops ?? [];
  if (postOps.length === 0) continue;
  zonesWithPostOps++;

  const refs = new Set<string>();
  for (const op of postOps) collectRefs(op, refs);
  if (refs.size === 0) continue;
  zonesWithRefs++;
  totalRefs += refs.size;

  let ctx;
  try {
    ctx = buildZoneContext(zid, defs);
  } catch (e) {
    process.stderr.write(`  [gen-fail] ${zid}: ${(e as Error).message}\n`);
    continue;
  }
  if (!ctx) continue;
  const live = new Set(ctx.named_regions);

  const missing = [...refs].filter((r) => !live.has(r));
  if (missing.length) {
    zonesWithMissingRefs++;
    totalMissing += missing.length;
    for (const m of missing) missingByRef.set(m, (missingByRef.get(m) ?? 0) + 1);
    if (sampleZones.length < 15) sampleZones.push(`${zid} [${zone.biome}]: missing ${missing.join(', ')}  (live: ${[...live].join(', ') || 'none'})`);
  }
}

console.log('\n=== Class A region-ref analysis ===');
console.log(`zones total:            ${zoneIds.length}`);
console.log(`zones with post_ops:    ${zonesWithPostOps}`);
console.log(`zones with region refs: ${zonesWithRefs}`);
console.log(`zones w/ MISSING refs:  ${zonesWithMissingRefs}`);
console.log(`total distinct refs:    ${totalRefs}`);
console.log(`total missing refs:     ${totalMissing}`);
console.log('\n--- missing ref ids, by # of zones ---');
for (const [ref, n] of [...missingByRef.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${ref}`);
}
console.log('\n--- sample affected zones ---');
for (const s of sampleZones) console.log('  ' + s);
