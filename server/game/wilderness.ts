// Continuous-wilderness streaming (docs/rework.md §8). The open world is one
// effectively-infinite field; we stream it as N×N chunks, one Socket.IO room
// per chunk (R8.1). Terrain is NEVER sent — the client derives it from the same
// shared field module (R8.2). This module owns:
//   - which chunks a player is subscribed to (load radius),
//   - deterministic per-chunk mob spawns, materialized while observed (§7.1),
//   - per-chunk entity broadcasts.

import type { Server as IOServer } from 'socket.io';
import type { World } from './world.ts';
import { makeMob } from './entities.ts';
import { CHUNK_SIZE, WILD, WILD_LOAD_RADIUS } from '../../shared/worldgen/config.ts';
import { dangerAt, getLevelBand, isWildBlocked, wildTileAt } from '../../shared/worldgen/field.ts';
import { mulberry32, gaussianSample } from '../../shared/worldgen/noise.ts';
import type { RegionAtlas } from '../../shared/worldgen/atlas.ts';
import type {
  ActiveZoneSnapshot, ClientToServerEvents, Entity, MobTemplate, PlayerEntity, ServerToClientEvents,
} from '../../shared/types.ts';

type IO = IOServer<ClientToServerEvents, ServerToClientEvents>;

export const chunkOf = (x: number, y: number) => ({
  cx: Math.floor(x / CHUNK_SIZE),
  cy: Math.floor(y / CHUNK_SIZE),
});
const chunkKey = (cx: number, cy: number) => `${cx},${cy}`;
export const roomName = (cx: number, cy: number) => `wild:${cx},${cy}`;

// Every role spawns in the open except npc (quest-givers/villagers, kept out
// of the wilderness on purpose) — a denylist so new roles are huntable by
// default with no registry edit needed here.
function isHuntable(t: MobTemplate): boolean {
  return t.role !== 'npc'
    && !t.friendly && !t.fixture && !t.sign && !t.inert
    && !t.shop && !t.trainer && !t.board_id;
}

// Levels a template is thematically valid at. Falls back to a small buffer
// around its authored `level` when `level_range` isn't set (see MobTemplate).
function levelRange(t: MobTemplate): [number, number] {
  return t.level_range ?? [Math.max(1, t.level - 2), t.level + 2];
}

function inLevelRange(t: MobTemplate, level: number): boolean {
  const [lo, hi] = levelRange(t);
  return level >= lo && level <= hi;
}

export class Wilderness {
  private world: World;
  private atlas: RegionAtlas;
  private io: IO;
  /** chunkKey → entityIds observing it. */
  private subscribers = new Map<string, Set<string>>();
  /** chunkKey → mob entity ids spawned for that chunk. */
  private chunkMobs = new Map<string, Set<string>>();
  /** entityId → chunkKeys it is currently subscribed to. */
  private playerChunks = new Map<string, Set<string>>();
  private huntable: MobTemplate[] = [];

  constructor(world: World, atlas: RegionAtlas, io: IO) {
    this.world = world;
    this.atlas = atlas;
    this.io = io;
    this.huntable = Object.values(world.defs.mobs).filter(isHuntable);
  }

  /** Settlement whose wilderness gate sits on (x,y), if any (return-portal check). */
  returnTargetAt(x: number, y: number): string | null {
    for (const st of this.atlas.settlements) {
      if (st.portalX === x && st.portalY === y) return st.id;
    }
    return null;
  }

  // ── Subscription / room management ─────────────────────────────────────────

  /** Reconcile a player's chunk subscriptions to their current position. Joins
   *  newly-in-range rooms (materializing their mobs + sending an initial chunk
   *  payload) and leaves out-of-range rooms (despawning unobserved mobs). */
  syncPlayer(player: PlayerEntity, socketIds: Iterable<string>): void {
    const { cx, cy } = chunkOf(player.position.x, player.position.y);
    const desired = new Set<string>();
    for (let dx = -WILD_LOAD_RADIUS; dx <= WILD_LOAD_RADIUS; dx++) {
      for (let dy = -WILD_LOAD_RADIUS; dy <= WILD_LOAD_RADIUS; dy++) {
        desired.add(chunkKey(cx + dx, cy + dy));
      }
    }
    const prev = this.playerChunks.get(player.id) ?? new Set<string>();
    const sids = [...socketIds];

    for (const key of desired) {
      if (prev.has(key)) continue;
      const [kx, ky] = key.split(',').map(Number) as [number, number];
      this.materializeChunk(kx, ky);
      this.addSub(key, player.id);
      for (const sid of sids) this.io.sockets.sockets.get(sid)?.join(roomName(kx, ky));
      // Initial payload for the joining player only.
      const entities = this.chunkEntities(kx, ky);
      const activeZones = this.chunkActiveZones(kx, ky);
      for (const sid of sids) {
        this.io.sockets.sockets.get(sid)?.emit('wild_chunk', { cx: kx, cy: ky, entities, tick: this.world.currentTick, activeZones });
      }
    }
    for (const key of prev) {
      if (desired.has(key)) continue;
      const [kx, ky] = key.split(',').map(Number) as [number, number];
      this.removeSub(key, player.id);
      for (const sid of sids) {
        this.io.sockets.sockets.get(sid)?.leave(roomName(kx, ky));
        this.io.sockets.sockets.get(sid)?.emit('wild_leave', { cx: kx, cy: ky });
      }
    }
    this.playerChunks.set(player.id, desired);
  }

  /** Drop a player from all wilderness subscriptions (logout / exit to a zone). */
  removePlayer(playerId: string, socketIds: Iterable<string>): void {
    const prev = this.playerChunks.get(playerId);
    if (!prev) return;
    const sids = [...socketIds];
    for (const key of prev) {
      const [kx, ky] = key.split(',').map(Number) as [number, number];
      this.removeSub(key, playerId);
      for (const sid of sids) this.io.sockets.sockets.get(sid)?.leave(roomName(kx, ky));
    }
    this.playerChunks.delete(playerId);
  }

  private addSub(key: string, playerId: string): void {
    let set = this.subscribers.get(key);
    if (!set) { set = new Set(); this.subscribers.set(key, set); }
    set.add(playerId);
  }

  private removeSub(key: string, playerId: string): void {
    const set = this.subscribers.get(key);
    if (!set) return;
    set.delete(playerId);
    if (set.size === 0) {
      this.subscribers.delete(key);
      this.despawnChunk(key);
    }
  }

  // ── Per-chunk entity broadcast ──────────────────────────────────────────────

  /** Push the authoritative entity list for every observed chunk to its room.
   *  Called each tick the wilderness is dirty. Full-replace semantics: a moving
   *  entity naturally leaves one chunk's list and joins the next. */
  broadcast(): void {
    for (const key of this.subscribers.keys()) {
      const [kx, ky] = key.split(',').map(Number) as [number, number];
      this.io.to(roomName(kx, ky)).emit('wild_chunk', {
        cx: kx, cy: ky,
        entities: this.chunkEntities(kx, ky),
        tick: this.world.currentTick,
        activeZones: this.chunkActiveZones(kx, ky),
      });
    }
  }

  private chunkEntities(cx: number, cy: number) {
    const out = [];
    for (const e of this.world.entitiesInZone(WILD)) {
      const c = chunkOf(e.position.x, e.position.y);
      if (c.cx === cx && c.cy === cy) out.push(this.world.entityToSnapshot(e));
    }
    return out;
  }

  // Ground zones (see World.activeZones / ZoneEffect) clipped to whichever
  // chunk their center falls in — same simplification chunkEntities makes for
  // mobs. Zone radii are small relative to CHUNK_SIZE, so edge-straddling is rare.
  private chunkActiveZones(cx: number, cy: number): ActiveZoneSnapshot[] {
    const out: ActiveZoneSnapshot[] = [];
    for (const z of this.world.activeZones.values()) {
      if (z.zoneId !== WILD) continue;
      const c = chunkOf(z.x, z.y);
      if (c.cx === cx && c.cy === cy) {
        out.push({ id: z.id, x: z.x, y: z.y, radius: z.radius, expiresAt: z.expiresAt, kind: z.effect.kind });
      }
    }
    return out;
  }

  // ── Deterministic spawns ────────────────────────────────────────────────────

  private materializeChunk(cx: number, cy: number): void {
    const key = chunkKey(cx, cy);
    if (this.chunkMobs.has(key)) return;
    const ids = new Set<string>();
    this.chunkMobs.set(key, ids);
    if (this.huntable.length === 0 || !this.world.wildSeeds) return;

    const rng = mulberry32((this.atlas.numericSeed ^ Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) >>> 0);
    const cxTile = cx * CHUNK_SIZE + CHUNK_SIZE / 2;
    const cyTile = cy * CHUNK_SIZE + CHUNK_SIZE / 2;
    const danger = dangerAt(cxTile, cyTile, this.world.wildSeeds, this.atlas);
    const band = getLevelBand(danger);
    const count = Math.round(1 + danger * 3); // 1..4 candidates, denser when deadlier

    // The band's [minLevel, maxLevel] is treated as ±1 SD around its center, so
    // sampled levels occasionally spill past the nominal band instead of
    // hard-clamping at chunk boundaries.
    const bandCenter = (band.minLevel + band.maxLevel) / 2;
    const bandSd = (band.maxLevel - band.minLevel) / 2;

    for (let i = 0; i < count; i++) {
      if (rng() > 0.7) continue;
      const level = Math.max(1, Math.min(100, Math.round(gaussianSample(rng, bandCenter, bandSd))));
      // Only spawn mobs thematically valid at this level (no starter critters
      // in the deep field); if none exist yet, skip rather than mis-theme.
      const candidates = this.huntable.filter((t) => inLevelRange(t, level));
      if (candidates.length === 0) continue;
      const template = candidates[Math.floor(rng() * candidates.length)]!;
      const pos = this.findSpawnTile(cx, cy, rng);
      if (!pos) continue;
      const mob = makeMob(template, { zone: WILD, x: pos.x, y: pos.y, level });
      this.world.addEntity(mob);
      ids.add(mob.id);
    }
  }

  private despawnChunk(key: string): void {
    const ids = this.chunkMobs.get(key);
    if (!ids) return;
    for (const id of ids) {
      const e = this.world.entities.get(id);
      // Keep mobs that are mid-fight; they'll be cleaned up when truly idle.
      if (e && e.type === 'mob' && !e.components.ai?.target) this.world.removeEntity(id);
    }
    this.chunkMobs.delete(key);
  }

  private findSpawnTile(cx: number, cy: number, rng: () => number): { x: number; y: number } | null {
    const seeds = this.world.wildSeeds!;
    for (let attempt = 0; attempt < 12; attempt++) {
      const x = cx * CHUNK_SIZE + Math.floor(rng() * CHUNK_SIZE);
      const y = cy * CHUNK_SIZE + Math.floor(rng() * CHUNK_SIZE);
      const tile = wildTileAt(x, y, seeds, this.atlas);
      if (tile === 'water' || tile === 'swamp_water' || tile === 'portal' || isWildBlocked(tile)) continue;
      if (this.world.entityAt(WILD, x, y)) continue;
      return { x, y };
    }
    return null;
  }
}

export type { Entity };
