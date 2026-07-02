import {
  applyMovement, DIRS,
} from './systems/movement.ts';
import { type AttackEvent } from './systems/combat.ts';
import { attackInFacing, attackTarget, executeAbility, tickModifiers, tickZones, type HealEvent, type CastEvent } from './systems/abilities.ts';
import { aiTick, applyFearFlee, maybeConfuse } from './systems/ai.ts';
import { dialogueTick } from './systems/dialogue.ts';
import { pickupGroundItemsAt, type PickupResult } from './systems/inventory.ts';
import { planPath } from './systems/autopath.ts';
import { isAlive } from './entities.ts';
import { effectiveMaxHealth, effectiveMaxMana, actCooldown, effectiveStat, ccFlags } from './systems/stats.ts';
import { MANA_REGEN_INTERVAL_TICKS, MANA_REGEN_PER_TICK } from '../../shared/constants.ts';
import { WILD } from '../../shared/worldgen/config.ts';
import type { CastFailure, CorpseEntity, Direction, Entity, PlayerEntity } from '../../shared/types.ts';
import type { World } from './world.ts';

const TICK_MS = 100;
// Matches mob actCooldown: BASE_ACT_TICKS / speed, so a speed-1 player and
// a speed-1 mob attack at the same rate. This gates the basic attack only.
const PLAYER_BASE_ACT_TICKS = 15;
// Global cooldown shared by the basic attack and every ability — the floor between
// any two actions. Shorter than the attack gate so abilities can be woven between
// auto-attack swings instead of replacing one (the old model gated both on
// PLAYER_BASE_ACT_TICKS, locking a caster to one action per attack interval).
// Mirrored client-side as GCD_MS in game.ts.
const GCD_TICKS = 8;
// Autopath movement speed in tiles per second. Supports fractional values (e.g. 7.5).
// Max is 1000/TICK_MS (10 at TICK_MS=100). Uses a per-entity accumulator for sub-tick precision.
const AUTOPATH_TILES_PER_SEC = 9;
// Full day = 20 real minutes.
const TICKS_PER_DAY = 12_000;
const REGEN_COMBAT_LOCKOUT_TICKS = 30;
const REGEN_INTERVAL_TICKS = 10;
const CORPSE_EMPTY_TTL_TICKS = 150;  // 15 s after last item taken
const CORPSE_MAX_TTL_MS = 120_000;   // 2 min hard cap

export type PendingAction =
  | { entityId: string; action: 'move'; dir: Direction }
  | { entityId: string; action: 'attack'; targetId?: string }
  | { entityId: string; action: 'ability'; abilityId: string; targetId?: string }
  | { entityId: string; action: 'autopath'; tx: number; ty: number };

export type LoopEvent =
  | AttackEvent
  | (PickupResult & { type: 'pickup'; entityId: string })
  | HealEvent
  | CastEvent
  | { type: 'utterance'; entityId: string; text: string }
  | { type: 'zone_change'; entityId: string; from: string; to: string }
  | { type: 'cast_failed'; entityId: string; abilityId: string; reason: CastFailure }
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
  autopathMoveAccum = new Map<string, number>();
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
    this.world.currentTick = this.tick;
    const events: LoopEvent[] = [];

    // Feared players have no autonomous "turn" the way mobs do (see stepMob's
    // fear branch in ai.ts) — this is that same behavior applied once per
    // tick for every feared player, forcing them to flee their fear source
    // regardless of what they queued below (rejected there instead).
    const fearedThisTick = new Set<string>();
    for (const e of this.world.entities.values()) {
      if (e.type !== 'player' || !isAlive(e)) continue;
      if (!ccFlags(e).has('fear')) continue;
      fearedThisTick.add(e.id);
      this.autopathPaths.delete(e.id);
      this.autopathMoveAccum.delete(e.id);
      if (applyFearFlee(this.world, e, ccFlags(e).has('confuse'))) this.dirtyZones.add(e.position.zone);
    }

    const batch = this.actions;
    this.actions = [];
    const actedThisTick = new Set<string>();
    for (const a of batch) {
      const e = this.world.entities.get(a.entityId);
      if (!e || !isAlive(e)) continue;
      // A feared player can't act deliberately this tick — their forced flee
      // step above already happened; drop whatever they queued.
      if (fearedThisTick.has(a.entityId) && (a.action === 'move' || a.action === 'attack' || a.action === 'ability' || a.action === 'autopath')) continue;
      if (a.action === 'autopath') {
        if (e.type === 'player') {
          const path = planPath(this.world, e.position.zone, e.position.x, e.position.y, a.tx, a.ty, e.id);
          if (path && path.length > 0) {
            this.autopathPaths.set(e.id, path);
            this.autopathMoveAccum.delete(e.id);
          } else {
            this.autopathPaths.delete(e.id);
            this.autopathMoveAccum.delete(e.id);
          }
        }
        continue;
      }
      // Explicit move or attack cancels any active autopath
      this.autopathPaths.delete(a.entityId);
      this.autopathMoveAccum.delete(a.entityId);
      actedThisTick.add(a.entityId);
      if (a.action === 'move') {
        if (e.type === 'player') {
          // Movement-speed gate: mobs already share one cadence for their
          // whole turn via nextActTick, but players previously had none for
          // movement specifically — so "slow" lengthened their attack gate
          // (nextActTick) but never actually slowed their walking at all.
          if (this.tick < (e.nextMoveTick || 0)) continue;
          // ceil (not actCooldown's round) so even a modest "slow" pushes the
          // gate past 1 tick — WASD is tick-quantized, so this is inherently
          // coarse; the autopath stepper below scales speed continuously.
          const moveSp = Math.max(0.1, effectiveStat(e, 'speed') || 1);
          e.nextMoveTick = this.tick + Math.max(1, Math.ceil(1 / moveSp));
        }
        // Confuse randomizes movement direction — already enforced for mobs
        // inside stepMob (ai.ts); nothing applied it to a player's own input.
        const confused = (e.type === 'player' || e.type === 'mob') && ccFlags(e).has('confuse');
        const dir = maybeConfuse(a.dir, confused) ?? a.dir;
        if (e.type === 'player' && this._tryEdgeWalk(e, dir, events)) {
          continue;
        }
        if (applyMovement(this.world, e, dir)) {
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
        if (this.tick < (e.nextActTick || 0)) continue;     // attack-speed gate
        if (this.tick < (e.nextGcdTick || 0)) continue;     // global cooldown (e.g. just cast)
        e.nextActTick = this.tick + actCooldown(e, PLAYER_BASE_ACT_TICKS);
        e.nextGcdTick = this.tick + GCD_TICKS;
        const ev = a.targetId
          ? attackTarget(this.world, e, a.targetId, this.tick)
          : attackInFacing(this.world, e, this.tick);
        if (ev) {
          events.push(ev);
          this.dirtyZones.add(e.position.zone);
        }
      } else if (a.action === 'ability') {
        if (e.type !== 'player') continue;
        if (this.tick < (e.nextGcdTick || 0)) continue; // global cooldown gates casts (not the attack gate)
        const ability = this.world.defs.abilities?.[a.abilityId];
        if (!ability) continue;
        const res = executeAbility(this.world, e, ability, this.tick, a.targetId);
        if (res.cast) {
          e.nextGcdTick = this.tick + GCD_TICKS; // a cast burns the GCD but leaves the attack gate alone
          events.push(...res.events);
          this.dirtyZones.add(e.position.zone);
        } else if (res.reason) {
          // Tell the caster why nothing happened so the client can explain + roll
          // back its optimistic cooldown (see castAbility / onCastFailed).
          events.push({ type: 'cast_failed', entityId: e.id, abilityId: a.abilityId, reason: res.reason });
        }
      }
    }

    // Advance server-side autopaths using a fractional accumulator for smooth speed control.
    // Each tick adds (AUTOPATH_TILES_PER_SEC * TICK_MS / 1000) to the accumulator;
    // a step is taken (and 1.0 consumed) whenever it reaches 1.0.
    const baseStep = AUTOPATH_TILES_PER_SEC * TICK_MS / 1000;
    for (const [entityId, path] of this.autopathPaths) {
      if (actedThisTick.has(entityId)) continue;
      const e = this.world.entities.get(entityId);
      if (!e || !isAlive(e) || e.type !== 'player') {
        this.autopathPaths.delete(entityId);
        this.autopathMoveAccum.delete(entityId);
        continue;
      }
      while (path.length > 0 && path[0]!.x === e.position.x && path[0]!.y === e.position.y) {
        path.shift();
      }
      if (path.length === 0) {
        this.autopathPaths.delete(entityId);
        this.autopathMoveAccum.delete(entityId);
        continue;
      }
      // Scale click-to-move by the player's effective speed so "slow" (and
      // haste) affect it the same way they gate WASD/attacks — otherwise
      // autopath walked at a flat rate regardless of any speed modifier.
      const accumStep = baseStep * Math.max(0.1, effectiveStat(e, 'speed') || 1);
      // Advance accumulator; only step when it reaches 1.0
      const accum = (this.autopathMoveAccum.get(entityId) ?? 0) + accumStep;
      if (accum < 1) {
        this.autopathMoveAccum.set(entityId, accum);
        continue;
      }
      const next = path[0]!;
      const dir = dirFromDelta(next.x - e.position.x, next.y - e.position.y);
      if (!dir) {
        this.autopathPaths.delete(entityId);
        this.autopathMoveAccum.delete(entityId);
        continue;
      }
      if (this._tryEdgeWalk(e, dir, events)) {
        // Zone changed — path is now invalid
        this.autopathPaths.delete(entityId);
        this.autopathMoveAccum.delete(entityId);
        continue;
      }
      const prevZone = e.position.zone;
      if (applyMovement(this.world, e, dir)) {
        // Consume 1.0 from the accumulator, carrying over any remainder
        this.autopathMoveAccum.set(entityId, accum - 1);
        path.shift();
        this.dirtyZones.add(e.position.zone);
        events.push({ type: 'player_moved', entityId: e.id });
        const picked = pickupGroundItemsAt(this.world, e);
        for (const p of picked) events.push({ type: 'pickup', entityId: e.id, ...p });
        this._tryPortal(e, events);
        if (e.position.zone !== prevZone) {
          this.autopathPaths.delete(entityId);
          this.autopathMoveAccum.delete(entityId);
        } else if (path.length === 0) {
          // Path completed — if the player landed at a zone boundary, walk through it
          if (this._tryEdgeWalk(e, dir, events)) {
            this.dirtyZones.add(e.position.zone);
          }
          this.autopathPaths.delete(entityId);
          this.autopathMoveAccum.delete(entityId);
        }
      } else {
        // Movement blocked — carry accumulator forward so we retry next tick
        this.autopathMoveAccum.set(entityId, accum);
      }
    }

    const aiResult = aiTick(this.world, this.tick);
    for (const z of aiResult.dirtyZones) this.dirtyZones.add(z);
    events.push(...aiResult.events);

    for (const u of dialogueTick(this.world, this.tick)) {
      events.push({ type: 'utterance', entityId: u.entityId, text: u.text });
    }

    // Advance status effects (dots/hots). Their damage/heal events join the
    // stream before the lockout loop, so a dot's fatal hit gets the same death
    // handling as any attack and a poison victim's regen is suppressed.
    for (const e of this.world.entities.values()) {
      if (e.type !== 'player' && e.type !== 'mob') continue;
      if (!isAlive(e)) continue;
      const modEvents = tickModifiers(this.world, e, this.tick);
      if (modEvents.length > 0) {
        events.push(...modEvents);
        this.dirtyZones.add(e.position.zone);
      }
    }

    // Persistent ground zones (see World.activeZones) — same event/dirty-zone
    // handling as the modifier pass above, just world-scoped instead of per-entity.
    const zoneEvents = tickZones(this.world, this.tick);
    for (const ev of zoneEvents) {
      events.push(ev);
      const t = this.world.entities.get(ev.targetId);
      if (t) this.dirtyZones.add(t.position.zone);
    }

    for (const ev of events) {
      if (ev.type !== 'attack') continue;
      const t = this.world.entities.get(ev.targetId);
      if (t && t.type !== 'ground_item' && t.type !== 'corpse') {
        t.nextRegenTick = this.tick + REGEN_COMBAT_LOCKOUT_TICKS;
        t.nextManaRegenTick = this.tick + REGEN_COMBAT_LOCKOUT_TICKS;
      }
    }

    for (const e of this.world.entities.values()) {
      if (e.type !== 'player' && e.type !== 'mob') continue;
      const h = e.components.health;
      const maxHp = effectiveMaxHealth(e);
      if (h && h.current < maxHp && h.current > 0 && this.tick >= (e.nextRegenTick || 0)) {
        e.nextRegenTick = this.tick + REGEN_INTERVAL_TICKS;
        h.current = Math.min(maxHp, h.current + 1);
        this.dirtyZones.add(e.position.zone);
      }
      // Mana regen mirrors health regen: flat amount on an interval, combat-locked.
      const m = e.components.mana;
      const maxMp = effectiveMaxMana(e);
      if (m && m.current < maxMp && this.tick >= (e.nextManaRegenTick || 0)) {
        e.nextManaRegenTick = this.tick + MANA_REGEN_INTERVAL_TICKS;
        m.current = Math.min(maxMp, m.current + MANA_REGEN_PER_TICK);
        this.dirtyZones.add(e.position.zone);
      }
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

    // Advance the global day/night clock.
    this.world.timeOfDay = (this.tick % TICKS_PER_DAY) / TICKS_PER_DAY;
    // Every 100 ticks (10 s) push a time update even to quiet zones so clients
    // don't stall on stale timeOfDay when nothing else is happening.
    if (this.tick % 100 === 0) {
      for (const zoneId of Object.keys(this.world.zones)) this.dirtyZones.add(zoneId);
    }

    if (this.dirtyZones.size > 0 && this.onTick) {
      const zones = this.dirtyZones;
      this.dirtyZones = new Set();
      this.onTick(zones);
    }
  }

  markZoneDirty(zoneId: string): void { this.dirtyZones.add(zoneId); }

  private _tryPortal(entity: PlayerEntity, events: LoopEvent[]): void {
    const { zone, x, y } = entity.position;
    // Wilderness has no zone def / portal list — its return gates live on the
    // atlas. Stepping onto a settlement gate returns to that enclosed zone.
    if (zone === WILD) {
      const toZone = this.world.wildReturnTargetAt(x, y);
      if (toZone && this.world.exitWilderness(entity, toZone)) {
        events.push({ type: 'zone_change', entityId: entity.id, from: zone, to: toZone });
        this.dirtyZones.add(WILD);
        this.dirtyZones.add(toZone);
      }
      return;
    }
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
