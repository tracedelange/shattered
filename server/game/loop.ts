import { applyMovement, DIRS } from './systems/movement.ts';
import { attackInFacing, type AttackEvent } from './systems/combat.ts';
import { aiTick } from './systems/ai.ts';
import { dialogueTick } from './systems/dialogue.ts';
import { pickupGroundItemsAt, type PickupResult } from './systems/inventory.ts';
import { isAlive } from './entities.ts';
import type { Direction, Entity, PlayerEntity } from '../../shared/types.ts';
import type { World } from './world.ts';

const TICK_MS = 100;
const PLAYER_ATTACK_COOLDOWN_TICKS = 8;
const REGEN_COMBAT_LOCKOUT_TICKS = 30;
const REGEN_INTERVAL_TICKS = 10;

export type PendingAction =
  | { entityId: string; action: 'move'; dir: Direction }
  | { entityId: string; action: 'attack' };

export type LoopEvent =
  | AttackEvent
  | (PickupResult & { type: 'pickup'; entityId: string })
  | { type: 'utterance'; entityId: string; text: string }
  | { type: 'zone_change'; entityId: string; from: string; to: string };

export class GameLoop {
  world: World;
  actions: PendingAction[] = [];
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
    for (const a of batch) {
      const e = this.world.entities.get(a.entityId);
      if (!e || !isAlive(e)) continue;
      if (a.action === 'move') {
        if (e.type === 'player' && this._tryEdgeWalk(e, a.dir, events)) {
          continue;
        }
        if (applyMovement(this.world, e, a.dir)) {
          this.dirtyZones.add(e.position.zone);
          if (e.type === 'player') {
            const picked = pickupGroundItemsAt(this.world, e);
            for (const p of picked) {
              events.push({ type: 'pickup', entityId: e.id, ...p });
            }
            this._tryPortal(e, events);
          }
        }
      } else if (a.action === 'attack') {
        if (e.type === 'ground_item') continue;
        if (this.tick < (e.nextActTick || 0)) continue;
        e.nextActTick = this.tick + PLAYER_ATTACK_COOLDOWN_TICKS;
        const ev = attackInFacing(this.world, e);
        if (ev) {
          events.push(ev);
          this.dirtyZones.add(e.position.zone);
        }
      }
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
      if (t && t.type !== 'ground_item') t.nextRegenTick = this.tick + REGEN_COMBAT_LOCKOUT_TICKS;
    }

    for (const e of this.world.entities.values()) {
      if (e.type !== 'player') continue;
      const h = e.components.health;
      if (!h || h.current >= h.max || h.current <= 0) continue;
      if (this.tick < (e.nextRegenTick || 0)) continue;
      e.nextRegenTick = this.tick + REGEN_INTERVAL_TICKS;
      h.current = Math.min(h.max, h.current + 1);
      this.dirtyZones.add(e.position.zone);
    }

    if (events.length > 0 && this.onEvents) this.onEvents(events);

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
