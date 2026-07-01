// Client-side continuous wilderness (docs/rework.md §8.2). Terrain is derived
// locally from the SAME shared field module the server validates against
// (determinism contract, R8.7); only entities arrive over the wire, per chunk.

import { state } from './state.ts';
import { CHUNK_SIZE, WILD } from '../../shared/worldgen/config.ts';
import { deriveSeeds, isWildBlocked, wildTileAt, type FieldSeeds } from '../../shared/worldgen/field.ts';
import type { RegionAtlas } from '../../shared/worldgen/atlas.ts';
import type { EntitySnapshot, WildChunkEvent, WildEnterEvent } from '../../shared/types.ts';

const BACKEND = import.meta.env.VITE_SERVER_URL ?? '';

let atlas: RegionAtlas | null = null;
let seeds: FieldSeeds | null = null;

// Per-chunk derived tile-id cache (R8.4: compute terrain once per chunk, not
// per frame). Keyed by "cx,cy"; flat array indexed (ly*CHUNK_SIZE + lx).
const tileCache = new Map<string, string[]>();
// Entities streamed per chunk; full-replace semantics from wild_chunk.
const chunkEntities = new Map<string, EntitySnapshot[]>();
// Every chunk the player has ever had streamed this session — the fog-of-war
// "explored" set for the world map. Not evicted on leave (unlike tileCache), so
// the map remembers where you've been. Session-scoped (resets on relog).
const visited = new Set<string>();

export const chunkOf = (x: number, y: number) => ({
  cx: Math.floor(x / CHUNK_SIZE),
  cy: Math.floor(y / CHUNK_SIZE),
});
const key = (cx: number, cy: number) => `${cx},${cy}`;

export function isWild(): boolean {
  return state.zone?.id === WILD;
}

export async function ensureAtlas(): Promise<void> {
  if (atlas) return;
  const r = await fetch(`${BACKEND}/api/atlas`);
  if (!r.ok) { console.error('[wild] atlas fetch failed', r.status); return; }
  atlas = await r.json() as RegionAtlas;
  seeds = deriveSeeds(atlas.numericSeed);
}

/** Tile id at a signed world coord. Caches a whole chunk on first touch. */
export function wildTile(x: number, y: number): string {
  if (!seeds) return 'void';
  const { cx, cy } = chunkOf(x, y);
  const k = key(cx, cy);
  let tiles = tileCache.get(k);
  if (!tiles) {
    tiles = new Array(CHUNK_SIZE * CHUNK_SIZE);
    const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE;
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        tiles[ly * CHUNK_SIZE + lx] = wildTileAt(ox + lx, oy + ly, seeds, atlas ?? undefined);
      }
    }
    tileCache.set(k, tiles);
  }
  const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const ly = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  return tiles[ly * CHUNK_SIZE + lx]!;
}

/** Whether a wilderness tile blocks movement (client-side prediction; the
 *  server is authoritative). Mirrors World.canMoveTo's wild branch. */
export function wildWalkable(x: number, y: number): boolean {
  return !isWildBlocked(wildTile(x, y));
}

/** All currently-streamed wilderness entities, flattened for render/pick. */
export function wildEntities(): EntitySnapshot[] {
  const out: EntitySnapshot[] = [];
  for (const list of chunkEntities.values()) out.push(...list);
  return out;
}

// ── Socket handlers ──────────────────────────────────────────────────────────

export async function onWildEnter(ev: WildEnterEvent): Promise<void> {
  await ensureAtlas();
  chunkEntities.clear();
  state.self = ev.self;
  // A minimal stub stands in for state.zone so the existing render guard passes;
  // id === WILD switches every wilderness-aware branch.
  state.zone = {
    id: WILD,
    name: 'The Wilds',
    width: 0,
    height: 0,
    grid: [],
    entities: [],
    tileset: 'overworld',
    no_edge_haze: true,
    timeOfDay: 0.5,
  };
  window.dispatchEvent(new CustomEvent('mmo:zone'));
  window.dispatchEvent(new CustomEvent('mmo:self'));
}

/** Chunks the player has explored this session (fog-of-war reveal set). */
export function visitedChunks(): ReadonlySet<string> { return visited; }
/** The loaded region atlas (settlements, danger radius), or null pre-load. */
export function getWildAtlas(): RegionAtlas | null { return atlas; }

export function onWildChunk(ev: WildChunkEvent): void {
  chunkEntities.set(key(ev.cx, ev.cy), ev.entities);
  visited.add(key(ev.cx, ev.cy));
  // Adopt the server's authoritative copy of self if present in this chunk.
  if (state.entityId) {
    const me = ev.entities.find(e => e.id === state.entityId);
    if (me && me.type === 'player') state.self = me as unknown as typeof state.self;
  }
}

export function onWildLeave(ev: { cx: number; cy: number }): void {
  const k = key(ev.cx, ev.cy);
  chunkEntities.delete(k);
  tileCache.delete(k);
}

/** Drop all wilderness state when returning to an enclosed zone. */
export function exitWild(): void {
  chunkEntities.clear();
  tileCache.clear();
}
