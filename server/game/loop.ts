import { applyMovement, DIRS } from './systems/movement.ts';
import { attackInFacing, type AttackEvent } from './systems/combat.ts';
import { aiTick } from './systems/ai.ts';
import { dialogueTick } from './systems/dialogue.ts';
import { pickupGroundItemsAt, type PickupResult } from './systems/inventory.ts';
import { planPath } from './systems/autopath.ts';
import { isAlive } from './entities.ts';
import type { CorpseEntity, Direction, Entity, PlayerEntity } from '../../shared/types.ts';
import type { World } from './world.ts';

const TICK_MS = 100;
// Matches mob actCooldown: BASE_ACT_TICKS / speed, so a speed-1 player and
// a speed-1 mob attack at the same rate.
const PLAYER_BASE_ACT_TICKS = 10;
const REGEN_COMBAT_LOCKOUT_TICKS = 30;
const REGEN_INTERVAL_TICKS = 10;
const CORPSE_EMPTY_TTL_TICKS = 150;  // 15 s after last item taken
const CORPSE_MAX_TTL_MS = 120_000;   // 2 min hard cap

export type PendingAction =
  | { entityId: string; action: 'move'; dir: Direction }
  | { entityId: string; action: 'attack' }
  | { entityId: string; action: 'autopath'; tx: number; ty: number };

export type LoopEvent =
  | AttackEvent
  | (PickupResult & { type: 'pickup'; entityId: string })
  | { type: 'utterance'; entityId: string; text: string }
  | { type: 'zone_change'; entityId: string; from: string; to: string }
  | { type: 'player_moved'; entityId: string };

function dirFromDelta(dx: number, dy: number): Direction | null {
  if (dx === 1  && dy === 0) return 'east';
  if (dx === -1 && dy === 0) return 'west';
  if (dx === 0  && dy === 1) return 'south';
  if (dx === 0  && dy === -1) return 'north';
  return null;
}

export class GameLoop {
  world: World;
  actions: PendingAction[] = [];
  autopathPaths = new Map<string, Array<{ x: number; y: number }>>();
  corpseEmptiedTick = new Map<string, number>();
  dirtyZones = new Set<string>();
  tick = 0;
  timer: ReturnType<typeof setInterval> | null = null;
  onTick: ((dirty: Set<string>) => void) | null = null;
  onEvents: ((events: LoopEvent[]) => void) | null = null;

  constructor(world: World) {
    this.world = world;
  }

  enqueue(action: PendingAction): void { this.actions.push(action); }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private _tick(): void {
    this.tick++;
    const events: LoopEvent[] = [];

    const batch = this.actions;
    this.actions = [];
    const actedThisTick = new Set<string>();
    for (const a of batch) {
      const e = this.world.entities.get(a.entityId);
      if (!e || !isAlive(e)) continue;
      if (a.action === 'autopath') {
        if (e.type === 'player') {
          const path = planPath(this.world, e.position.zone, e.position.x, e.position.y, a.tx, a.ty, e.id);
          if (path && path.length > 0) {
            this.autopathPaths.set(e.id, path);
          } else {
            this.autopathPaths.delete(e.id);
          }
        }
        continue;
      }
      // Explicit move or attack cancels any active autopath
      this.autopathPaths.delete(a.entityId);
      actedThisTick.add(a.entityId);
      if (a.action === 'move') {
        if (e.type === 'player' && this._tryEdgeWalk(e, a.dir, events)) {
          continue;
        }
        if (applyMovement(this.world, e, a.dir)) {
          this.dirtyZones.add(e.position.zone);
          if (e.type === 'player') {
            events.push({ type: 'player_moved', entityId: e.id });
            const picked = pickupGroundItemsAt(this.world, e);
            for (const p of picked) {
              events.push({ type: 'pickup', entityId: e.id, ...p });
            }
            this._tryPortal(e, events);
          }
        }
      } else if (a.action === 'attack') {
        if (e.type === 'ground_item' || e.type === 'corpse') continue;
        if (this.tick < (e.nextActTick || 0)) continue;
        const spd = (e.type === 'player' ? e.components.stats?.speed : null) || 1.0;
        e.nextActTick = this.tick + Math.max(1, Math.round(PLAYER_BASE_ACT_TICKS / spd));
        const ev = attackInFacing(this.world, e);
        if (ev) {
          events.push(ev);
          this.dirtyZones.add(e.position.zone);
        }
      }
    }

    // Advance server-side autopaths one step per tick
    for (const [entityId, path] of this.autopathPaths) {
      if (actedThisTick.has(entityId)) continue;
      const e = this.world.entities.get(entityId);
      if (!e || !isAlive(e) || e.type !== 'player') { this.autopathPaths.delete(entityId); continue; }
      while (path.length > 0 && path[0]!.x === e.position.x && path[0]!.y === e.position.y) {
        path.shift();
      }
      if (path.length === 0) { this.autopathPaths.delete(entityId); continue; }
      const next = path[0]!;
      const dir = dirFromDelta(next.x - e.position.x, next.y - e.position.y);
      if (!dir) { this.autopathPaths.delete(entityId); continue; }
      if (this._tryEdgeWalk(e, dir, events)) {
        // Zone changed — path is now invalid
        this.autopathPaths.delete(entityId);
        continue;
      }
      const prevZone = e.position.zone;
      if (applyMovement(this.world, e, dir)) {
        path.shift();
        this.dirtyZones.add(e.position.zone);
        events.push({ type: 'player_moved', entityId: e.id });
        const picked = pickupGroundItemsAt(this.world, e);
        for (const p of picked) events.push({ type: 'pickup', entityId: e.id, ...p });
        this._tryPortal(e, events);
        if (e.position.zone !== prevZone) this.autopathPaths.delete(entityId);
      }
      // If applyMovement failed (entity blocking), retry next tick
    }

    const aiResult = aiTick(this.world, this.tick);
    for (const z of aiResult.dirtyZones) this.dirtyZones.add(z);
    events.push(...aiResult.events);

    for (const u of dialogueTick(this.world, this.tick)) {
      events.push({ type: 'utterance', entityId: u.entityId, text: u.text });
    }

    for (const ev of events) {
      if (ev.type !== 'attack') continue;
      const t = this.world.entities.get(ev.targetId);
      if (t && t.type !== 'ground_item' && t.type !== 'corpse') t.nextRegenTick = this.tick + REGEN_COMBAT_LOCKOUT_TICKS;
    }

    for (const e of this.world.entities.values()) {
      if (e.type !== 'player' && e.type !== 'mob') continue;
      const h = e.components.health;
      if (!h || h.current >= h.max || h.current <= 0) continue;
      if (this.tick < (e.nextRegenTick || 0)) continue;
      e.nextRegenTick = this.tick + REGEN_INTERVAL_TICKS;
      h.current = Math.min(h.max, h.current + 1);
      this.dirtyZones.add(e.position.zone);
    }

    if (events.length > 0 && this.onEvents) this.onEvents(events);

    // Corpse TTL cleanup (every 10 ticks)
    if (this.tick % 10 === 0) {
      const now = Date.now();
      for (const [id, emptiedTick] of this.corpseEmptiedTick) {
        if (this.tick - emptiedTick >= CORPSE_EMPTY_TTL_TICKS) {
          const e = this.world.entities.get(id);
          if (e) { this.dirtyZones.add(e.position.zone); this.world.removeEntity(id); }
          this.corpseEmptiedTick.delete(id);
        }
      }
      for (const e of this.world.entities.values()) {
        if (e.type !== 'corpse') continue;
        if (now - (e as CorpseEntity).createdAtMs >= CORPSE_MAX_TTL_MS) {
          this.dirtyZones.add(e.position.zone);
          this.world.removeEntity(e.id);
          this.corpseEmptiedTick.delete(e.id);
        }
      }
    }

    const respawnDirty = this.world.tickRespawns(this.tick);
    for (const z of respawnDirty) this.dirtyZones.add(z);

    if (this.dirtyZones.size > 0 && this.onTick) {
      const zones = this.dirtyZones;
      this.dirtyZones = new Set();
      this.onTick(zones);
    }
  }

  markZoneDirty(zoneId: string): void { this.dirtyZones.add(zoneId); }

  private _tryPortal(entity: PlayerEntity, events: LoopEvent[]): void {
    const { zone, x, y } = entity.position;
    const portal = this.world.portalAt(zone, x, y);
    if (!portal?.to?.zone) return;
    const ok = this.world.teleportPlayer(entity, portal.to.zone, portal.to.x | 0, portal.to.y | 0);
    if (ok) {
      events.push({ type: 'zone_change', entityId: entity.id, from: zone, to: portal.to.zone });
      this.dirtyZones.add(zone);
      this.dirtyZones.add(portal.to.zone);
    }
  }

  private _tryEdgeWalk(entity: PlayerEntity, dir: Direction, events: LoopEvent[]): boolean {
    const d = DIRS[dir];
    if (!d) return false;
    const { zone, x, y } = entity.position;
    const z = this.world.zones[zone];
    if (!z) return false;
    const nx = x + d.dx, ny = y + d.dy;
    const inBounds = nx >= 0 && nx < z.width && ny >= 0 && ny < z.height;
    if (inBounds) return false;
    const toZoneId = z.def?.connections?.[dir];
    if (!toZoneId) return false;
    const ok = this.world.transitionPlayer(entity, dir, toZoneId);
    if (ok) {
      events.push({ type: 'zone_change', entityId: entity.id, from: zone, to: toZoneId });
      this.dirtyZones.add(zone);
      this.dirtyZones.add(toZoneId);
    }
    return true;
  }
}
