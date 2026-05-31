import { applyMovement, DIRS } from './systems/movement.js';
import { attackInFacing } from './systems/combat.js';
import { aiTick } from './systems/ai.js';
import { dialogueTick } from './systems/dialogue.js';
import { pickupGroundItemsAt } from './systems/inventory.js';
import { isAlive } from './entities.js';

const TICK_MS = 100;
const PLAYER_ATTACK_COOLDOWN_TICKS = 8;
const REGEN_COMBAT_LOCKOUT_TICKS = 30;  // 3.0s after being hit, no regen
const REGEN_INTERVAL_TICKS = 10;        // +1 HP per 1.0s while out of combat

export class GameLoop {
  constructor(world) {
    this.world = world;
    this.actions = [];      // [{ entityId, action, dir? }]
    this.dirtyZones = new Set();
    this.tick = 0;
    this.timer = null;
    this.onTick = null;     // (dirtyZones: Set<string>) => void
    this.onEvents = null;   // (events: Array) => void
  }

  enqueue(action) { this.actions.push(action); }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _tick() {
    this.tick++;
    const events = [];

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

    // Combat lockout: any entity that took a hit this tick (alive or not)
    // pauses regen. Done after AI so all damage events are collected.
    for (const ev of events) {
      if (ev.type !== 'attack') continue;
      const t = this.world.entities.get(ev.targetId);
      if (t) t.nextRegenTick = this.tick + REGEN_COMBAT_LOCKOUT_TICKS;
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

    // Respawns fire one tick after the death is scheduled — deliberate.
    const respawnDirty = this.world.tickRespawns(this.tick);
    for (const z of respawnDirty) this.dirtyZones.add(z);

    if (this.dirtyZones.size > 0 && this.onTick) {
      const zones = this.dirtyZones;
      this.dirtyZones = new Set();
      this.onTick(zones);
    }
  }

  markZoneDirty(zoneId) { this.dirtyZones.add(zoneId); }

  _tryPortal(entity, events) {
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

  // Returns true if the move was consumed as a zone transition (success or
  // failure), so the caller doesn't also handle it as a normal move.
  _tryEdgeWalk(entity, dir, events) {
    const d = DIRS[dir];
    if (!d) return false;
    const { zone, x, y } = entity.position;
    const z = this.world.zones[zone];
    if (!z) return false;
    const nx = x + d.dx, ny = y + d.dy;
    const inBounds = nx >= 0 && nx < z.width && ny >= 0 && ny < z.height;
    if (inBounds) return false;
    const toZoneId = z.def?.connections?.[dir];
    if (!toZoneId) return false; // hitting an unconnected edge: let movement fail normally
    const ok = this.world.transitionPlayer(entity, dir, toZoneId);
    if (ok) {
      events.push({ type: 'zone_change', entityId: entity.id, from: zone, to: toZoneId });
      this.dirtyZones.add(zone);
      this.dirtyZones.add(toZoneId);
    }
    return true; // consumed either way — don't double-handle as a normal move
  }
}
