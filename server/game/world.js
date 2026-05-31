import { generateZoneGrid, isBlocked } from './mapgen.js';
import { makeMob } from './entities.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const DEFAULT_RESPAWN_SECONDS = 30;
const TICKS_PER_SECOND = 10;        // matches loop.js TICK_MS=100
const RESPAWN_RETRY_TICKS = 20;     // if no free tile, try again in 2s

export class World {
  constructor() {
    this.defs = null;             // { zones, mobs, itemBases, affixes, quests, tilesets }
    this.zones = {};              // zoneId -> { def, grid, bounds }
    this.entities = new Map();    // entityId -> entity
    this.byZone = new Map();      // zoneId -> Set<entityId>
    this.pendingRespawns = new Map(); // zoneId -> Array<{spawnIndex, dueTick}>
  }

  setDefinitions(defs) {
    this.defs = defs;
    for (const zoneId of Object.keys(defs.zones)) {
      this._rebuildZone(zoneId);
    }
  }

  _rebuildZone(zoneId) {
    const def = this.defs.zones[zoneId];
    const { grid, bounds, width, height } = generateZoneGrid(def, this.defs.regionTypes || {});
    const prev = this.zones[zoneId];
    this.zones[zoneId] = { def, grid, bounds, width, height };

    if (prev) {
      for (const id of [...(this.byZone.get(zoneId) || [])]) {
        const e = this.entities.get(id);
        if (e && e.type !== 'player') this.removeEntity(id);
      }
    } else {
      this.byZone.set(zoneId, new Set());
    }

    this._spawnZoneEntities(zoneId);
  }

  _spawnZoneEntities(zoneId) {
    // Reset pending respawns — a zone rebuild discards stale schedules.
    this.pendingRespawns.set(zoneId, []);
    const { def, bounds } = this.zones[zoneId];
    const spawns = def.spawns || [];
    for (let i = 0; i < spawns.length; i++) {
      const spawn = spawns[i];
      const template = this.defs.mobs[spawn.entity];
      if (!template) continue;
      const region = bounds[spawn.region];
      if (!region) continue;
      for (let k = 0; k < (spawn.count || 1); k++) {
        this._spawnOne(zoneId, i, template, region);
      }
    }
  }

  _spawnOne(zoneId, spawnIndex, template, region) {
    const pos = this._findFreeTileInRegion(zoneId, region);
    if (!pos) return null;
    const spawn = this.zones[zoneId].def.spawns[spawnIndex];
    const mob = makeMob(template, { zone: zoneId, x: pos.x, y: pos.y });
    mob.components.ai.spawn_region = spawn.region;
    mob.spawnRef = { zoneId, spawnIndex };
    this.addEntity(mob);
    return mob;
  }

  scheduleRespawn(mob, currentTick) {
    const ref = mob?.spawnRef;
    if (!ref) return;
    const spawn = this.zones[ref.zoneId]?.def?.spawns?.[ref.spawnIndex];
    if (!spawn) return;
    const delaySec = spawn.respawn_seconds ?? DEFAULT_RESPAWN_SECONDS;
    if (delaySec <= 0) return;
    const dueTick = currentTick + Math.max(1, Math.round(delaySec * TICKS_PER_SECOND));
    const q = this.pendingRespawns.get(ref.zoneId) || [];
    q.push({ spawnIndex: ref.spawnIndex, dueTick });
    this.pendingRespawns.set(ref.zoneId, q);
  }

  tickRespawns(currentTick) {
    const dirty = new Set();
    for (const [zoneId, q] of this.pendingRespawns) {
      if (!q.length) continue;
      const remaining = [];
      for (const item of q) {
        if (currentTick < item.dueTick) { remaining.push(item); continue; }
        const z = this.zones[zoneId];
        const spawn = z?.def?.spawns?.[item.spawnIndex];
        if (!spawn) continue;
        const template = this.defs.mobs[spawn.entity];
        const region = z.bounds[spawn.region];
        if (!template || !region) continue;
        const mob = this._spawnOne(zoneId, item.spawnIndex, template, region);
        if (mob) {
          dirty.add(zoneId);
        } else {
          // No free tile — try again later instead of dropping the respawn.
          remaining.push({ spawnIndex: item.spawnIndex, dueTick: currentTick + RESPAWN_RETRY_TICKS });
        }
      }
      this.pendingRespawns.set(zoneId, remaining);
    }
    return dirty;
  }

  _findFreeTileInRegion(zoneId, region, attempts = 20) {
    for (let i = 0; i < attempts; i++) {
      const x = region.x + 1 + Math.floor(Math.random() * Math.max(1, region.w - 2));
      const y = region.y + 1 + Math.floor(Math.random() * Math.max(1, region.h - 2));
      if (this.canMoveTo(zoneId, x, y) && !this.entityAt(zoneId, x, y)) return { x, y };
    }
    return null;
  }

  addEntity(entity) {
    this.entities.set(entity.id, entity);
    const zone = entity.position.zone;
    if (!this.byZone.has(zone)) this.byZone.set(zone, new Set());
    this.byZone.get(zone).add(entity.id);
  }

  removeEntity(id) {
    const e = this.entities.get(id);
    if (!e) return;
    this.byZone.get(e.position.zone)?.delete(id);
    this.entities.delete(id);
  }

  // Move an entity to a new tile (optionally in another zone). Keeps byZone in
  // sync. Returns the entity for chaining.
  _relocate(entity, toZoneId, x, y, facing = null) {
    this.byZone.get(entity.position.zone)?.delete(entity.id);
    entity.position.zone = toZoneId;
    entity.position.x = x;
    entity.position.y = y;
    if (facing) entity.facing = facing;
    if (!this.byZone.has(toZoneId)) this.byZone.set(toZoneId, new Set());
    this.byZone.get(toZoneId).add(entity.id);
    return entity;
  }

  getZoneSpawnPoint(zoneId) {
    const z = this.zones[zoneId];
    if (!z) return { x: 0, y: 0 };
    // Drop the player in the center region if there is one, else center of grid.
    const center = Object.values(z.bounds).find(b => b.type === 'plaza') || null;
    if (center) {
      return {
        x: center.x + Math.floor(center.w / 2),
        y: center.y + Math.floor(center.h / 2),
      };
    }
    return { x: Math.floor(z.width / 2), y: Math.floor(z.height / 2) };
  }

  entitiesInZone(zoneId) {
    const ids = this.byZone.get(zoneId) || new Set();
    return [...ids].map(id => this.entities.get(id)).filter(Boolean);
  }

  canMoveTo(zoneId, x, y) {
    const z = this.zones[zoneId];
    if (!z) return false;
    return !isBlocked(z.grid, x, y);
  }

  // Blocking lookup — passable entities (ground items) are not returned.
  entityAt(zoneId, x, y) {
    const ids = this.byZone.get(zoneId);
    if (!ids) return null;
    for (const id of ids) {
      const e = this.entities.get(id);
      if (!e || e.passable) continue;
      if (e.position.x === x && e.position.y === y) return e;
    }
    return null;
  }

  groundItemsAt(zoneId, x, y) {
    const ids = this.byZone.get(zoneId);
    const out = [];
    if (!ids) return out;
    for (const id of ids) {
      const e = this.entities.get(id);
      if (!e || e.type !== 'ground_item') continue;
      if (e.position.x === x && e.position.y === y) out.push(e);
    }
    return out;
  }

  regionBounds(zoneId, regionId) {
    return this.zones[zoneId]?.bounds[regionId] || null;
  }

  // Snaps to a nearby free tile if the exact destination is blocked.
  teleportPlayer(entity, toZoneId, toX, toY) {
    const toZone = this.zones[toZoneId];
    if (!toZone) return false;
    const ex = clamp(toX, 0, toZone.width - 1);
    const ey = clamp(toY, 0, toZone.height - 1);
    const { x, y } = this._findFreeNear(toZoneId, ex, ey) || { x: ex, y: ey };
    this._relocate(entity, toZoneId, x, y);
    return true;
  }

  // Lookup a portal at (zoneId, x, y) — returns the portal def or null.
  portalAt(zoneId, x, y) {
    const portals = this.zones[zoneId]?.def?.portals || [];
    return portals.find(p => p.at?.x === x && p.at?.y === y) || null;
  }

  // Edge-walk: emerge at the opposite edge of toZoneId, preserving the
  // lateral coordinate. Caller fires the zone_change event.
  transitionPlayer(entity, dir, toZoneId) {
    const toZone = this.zones[toZoneId];
    if (!toZone) return false;

    const { x: fromX, y: fromY } = entity.position;
    let entryX, entryY;
    if (dir === 'north')      { entryX = clamp(fromX, 0, toZone.width - 1);  entryY = toZone.height - 1; }
    else if (dir === 'south') { entryX = clamp(fromX, 0, toZone.width - 1);  entryY = 0; }
    else if (dir === 'east')  { entryX = 0;                                  entryY = clamp(fromY, 0, toZone.height - 1); }
    else if (dir === 'west')  { entryX = toZone.width - 1;                   entryY = clamp(fromY, 0, toZone.height - 1); }
    else return false;

    const { x, y } = this._findFreeNear(toZoneId, entryX, entryY) || { x: entryX, y: entryY };
    this._relocate(entity, toZoneId, x, y, dir);
    return true;
  }

  _findFreeNear(zoneId, x0, y0, maxRadius = 8) {
    if (this.canMoveTo(zoneId, x0, y0) && !this.entityAt(zoneId, x0, y0)) return { x: x0, y: y0 };
    for (let r = 1; r <= maxRadius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring at radius r
          const nx = x0 + dx, ny = y0 + dy;
          if (this.canMoveTo(zoneId, nx, ny) && !this.entityAt(zoneId, nx, ny)) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  snapshotZone(zoneId) {
    const z = this.zones[zoneId];
    if (!z) return null;
    return {
      id: zoneId,
      name: z.def?.name || zoneId,
      width: z.width,
      height: z.height,
      grid: z.grid,
      entities: this.entitiesInZone(zoneId).map(e => {
        const snap = {
          id: e.id,
          type: e.type,
          name: e.name,
          sprite: e.sprite || (e.type === 'player' ? 'player' : null),
          position: e.position,
          components: e.components,
        };
        if (e.type === 'ground_item') {
          snap.base = e.base;
          snap.gold = e.gold;
          snap.item = e.item;
        }
        return snap;
      }),
    };
  }
}
