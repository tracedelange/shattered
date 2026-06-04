import { generateZoneGrid, isBlocked, type RegionBounds, type ZoneGrid } from './mapgen/index.ts';
import { makeMob } from './entities.ts';
import type {
  CorpseEntity, Direction, Entity, EntitySnapshot, GroundItemEntity, MobEntity, PlayerEntity,
  WorldDefs, ZoneDef, ZoneSnapshot,
} from '../../shared/types.ts';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const DEFAULT_RESPAWN_SECONDS = 120;
const TICKS_PER_SECOND = 10;
const RESPAWN_RETRY_TICKS = 20;

interface ZoneRuntime extends ZoneGrid { def: ZoneDef }
interface PendingRespawn { spawnIndex: number; dueTick: number }

export class World {
  defs: WorldDefs = null as unknown as WorldDefs;
  zones: Record<string, ZoneRuntime> = {};
  entities: Map<string, Entity> = new Map();
  byZone: Map<string, Set<string>> = new Map();
  pendingRespawns: Map<string, PendingRespawn[]> = new Map();

  setDefinitions(defs: WorldDefs): void {
    this.defs = defs;
    for (const zoneId of Object.keys(defs.zones)) {
      this._rebuildZone(zoneId);
    }
  }

  private _rebuildZone(zoneId: string): void {
    const def = this.defs.zones[zoneId]!;
    const { grid, bounds, width, height } = generateZoneGrid(def);
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

  private _spawnZoneEntities(zoneId: string): void {
    this.pendingRespawns.set(zoneId, []);
    const { def, bounds } = this.zones[zoneId]!;
    const spawns = def.spawns || [];
    for (let i = 0; i < spawns.length; i++) {
      const spawn = spawns[i]!;
      const template = this.defs.mobs[spawn.entity];
      if (!template) continue;
      const region = bounds[spawn.region];
      if (!region) continue;
      for (let k = 0; k < (spawn.count || 1); k++) {
        this._spawnOne(zoneId, i, template, region);
      }
    }
  }

  private _spawnOne(zoneId: string, spawnIndex: number, template: WorldDefs['mobs'][string], region: RegionBounds): MobEntity | null {
    const pos = this._findFreeTileInRegion(zoneId, region);
    if (!pos) return null;
    const spawn = this.zones[zoneId]!.def.spawns![spawnIndex]!;
    const mob = makeMob(template, { zone: zoneId, x: pos.x, y: pos.y, spawnId: spawn.spawn_id });
    mob.components.ai.spawn_region = spawn.region;
    mob.spawnRef = { zoneId, spawnIndex };
    this.addEntity(mob);
    return mob;
  }

  scheduleRespawn(mob: MobEntity, currentTick: number): void {
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

  tickRespawns(currentTick: number): Set<string> {
    const dirty = new Set<string>();
    for (const [zoneId, q] of this.pendingRespawns) {
      if (!q.length) continue;
      const remaining: PendingRespawn[] = [];
      for (const item of q) {
        if (currentTick < item.dueTick) { remaining.push(item); continue; }
        const z = this.zones[zoneId];
        const spawn = z?.def?.spawns?.[item.spawnIndex];
        if (!spawn) continue;
        const template = this.defs.mobs[spawn.entity];
        const region = z!.bounds[spawn.region];
        if (!template || !region) continue;
        const mob = this._spawnOne(zoneId, item.spawnIndex, template, region);
        if (mob) {
          dirty.add(zoneId);
        } else {
          remaining.push({ spawnIndex: item.spawnIndex, dueTick: currentTick + RESPAWN_RETRY_TICKS });
        }
      }
      this.pendingRespawns.set(zoneId, remaining);
    }
    return dirty;
  }

  private _findFreeTileInRegion(zoneId: string, region: RegionBounds, attempts = 20): { x: number; y: number } | null {
    for (let i = 0; i < attempts; i++) {
      const x = region.x + 1 + Math.floor(Math.random() * Math.max(1, region.w - 2));
      const y = region.y + 1 + Math.floor(Math.random() * Math.max(1, region.h - 2));
      if (this.canMoveTo(zoneId, x, y) && !this.entityAt(zoneId, x, y)) return { x, y };
    }
    return null;
  }

  addEntity(entity: Entity): void {
    this.entities.set(entity.id, entity);
    const zone = entity.position.zone;
    if (!this.byZone.has(zone)) this.byZone.set(zone, new Set());
    this.byZone.get(zone)!.add(entity.id);
  }

  removeEntity(id: string): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.byZone.get(e.position.zone)?.delete(id);
    this.entities.delete(id);
  }

  private _relocate(entity: Entity, toZoneId: string, x: number, y: number, facing: Direction | null = null): Entity {
    this.byZone.get(entity.position.zone)?.delete(entity.id);
    entity.position.zone = toZoneId;
    entity.position.x = x;
    entity.position.y = y;
    if (facing && entity.type !== 'ground_item' && entity.type !== 'corpse') entity.facing = facing;
    if (!this.byZone.has(toZoneId)) this.byZone.set(toZoneId, new Set());
    this.byZone.get(toZoneId)!.add(entity.id);
    return entity;
  }

  getZoneSpawnPoint(zoneId: string): { x: number; y: number } {
    const z = this.zones[zoneId];
    if (!z) return { x: 0, y: 0 };
    const sp = z.def?.spawn_point;
    if (sp) {
      if ('region' in sp) {
        const r = z.bounds[sp.region];
        if (r) return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
      } else {
        return { x: sp.x, y: sp.y };
      }
    }
    return { x: Math.floor(z.width / 2), y: Math.floor(z.height / 2) };
  }

  entitiesInZone(zoneId: string): Entity[] {
    const ids = this.byZone.get(zoneId) || new Set<string>();
    return [...ids].map(id => this.entities.get(id)).filter((e): e is Entity => Boolean(e));
  }

  canMoveTo(zoneId: string, x: number, y: number): boolean {
    const z = this.zones[zoneId];
    if (!z) return false;
    return !isBlocked(z.grid, x, y);
  }

  entityAt(zoneId: string, x: number, y: number): Entity | null {
    const ids = this.byZone.get(zoneId);
    if (!ids) return null;
    for (const id of ids) {
      const e = this.entities.get(id);
      if (!e || (e as GroundItemEntity).passable) continue;
      if (e.position.x === x && e.position.y === y) return e;
    }
    return null;
  }

  groundItemsAt(zoneId: string, x: number, y: number): GroundItemEntity[] {
    const ids = this.byZone.get(zoneId);
    const out: GroundItemEntity[] = [];
    if (!ids) return out;
    for (const id of ids) {
      const e = this.entities.get(id);
      if (!e || e.type !== 'ground_item') continue;
      if (e.position.x === x && e.position.y === y) out.push(e);
    }
    return out;
  }

  regionBounds(zoneId: string, regionId: string): RegionBounds | null {
    return this.zones[zoneId]?.bounds[regionId] || null;
  }

  teleportPlayer(entity: PlayerEntity, toZoneId: string, toX: number, toY: number): boolean {
    const toZone = this.zones[toZoneId];
    if (!toZone) return false;
    const ex = clamp(toX, 0, toZone.width - 1);
    const ey = clamp(toY, 0, toZone.height - 1);
    const { x, y } = this._findFreeNear(toZoneId, ex, ey) || { x: ex, y: ey };
    this._relocate(entity, toZoneId, x, y);
    return true;
  }

  portalAt(zoneId: string, x: number, y: number) {
    const portals = this.zones[zoneId]?.def?.portals || [];
    return portals.find(p => p.at?.x === x && p.at?.y === y) || null;
  }

  transitionPlayer(entity: PlayerEntity, dir: Direction, toZoneId: string): boolean {
    const toZone = this.zones[toZoneId];
    if (!toZone) return false;
    const { x: fromX, y: fromY } = entity.position;
    let entryX: number, entryY: number;
    if (dir === 'north')      { entryX = clamp(fromX, 0, toZone.width - 1);  entryY = toZone.height - 1; }
    else if (dir === 'south') { entryX = clamp(fromX, 0, toZone.width - 1);  entryY = 0; }
    else if (dir === 'east')  { entryX = 0;                                  entryY = clamp(fromY, 0, toZone.height - 1); }
    else                       { entryX = toZone.width - 1;                   entryY = clamp(fromY, 0, toZone.height - 1); }
    const { x, y } = this._findFreeNear(toZoneId, entryX, entryY) || { x: entryX, y: entryY };
    this._relocate(entity, toZoneId, x, y, dir);
    return true;
  }

  private _findFreeNear(zoneId: string, x0: number, y0: number, maxRadius = 8): { x: number; y: number } | null {
    if (this.canMoveTo(zoneId, x0, y0) && !this.entityAt(zoneId, x0, y0)) return { x: x0, y: y0 };
    for (let r = 1; r <= maxRadius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x0 + dx, ny = y0 + dy;
          if (this.canMoveTo(zoneId, nx, ny) && !this.entityAt(zoneId, nx, ny)) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  snapshotZone(zoneId: string): ZoneSnapshot | null {
    const z = this.zones[zoneId];
    if (!z) return null;
    return {
      id: zoneId,
      name: z.def?.name || zoneId,
      width: z.width,
      height: z.height,
      grid: z.grid,
      entities: this.entitiesInZone(zoneId).map((e): EntitySnapshot => {
        const sprite = (e as MobEntity | GroundItemEntity).sprite
          || (e.type === 'player' ? 'player' : null);
        const snap: EntitySnapshot = {
          id: e.id,
          type: e.type,
          name: e.name,
          sprite,
          position: e.position,
          components: (e as PlayerEntity | MobEntity).components,
        };
        if (e.type === 'player') {
          snap.klass  = (e as PlayerEntity).klass;
          snap.color  = (e as PlayerEntity).color;
        }
        if (e.type === 'mob') {
          const mob = e as MobEntity;
          const templateId = mob.components.ai?.template_id;
          snap.templateId = templateId;
          snap.spawnId    = mob.components.ai?.spawn_id;
          snap.level      = mob.level;
          if (templateId && this.defs.mobs[templateId]?.shop?.length) snap.hasShop = true;
          if (mob.components.ai?.fixture) snap.fixture = true;
        }
        if (e.type === 'ground_item') {
          snap.base = e.base;
          snap.gold = e.gold;
          snap.item = e.item;
        }
        if (e.type === 'corpse') {
          snap.loot = e.loot;
          snap.createdAtMs = e.createdAtMs;
        }
        return snap;
      }),
    };
  }
}
