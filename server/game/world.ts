import { findWalkableEdgeTile, generateZoneGrid, isBlocked, type RegionBounds, type ZoneGrid } from './mapgen/index.ts';
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
  /** Current time of day: 0=midnight, 0.25=dawn, 0.5=noon, 0.75=dusk. */
  timeOfDay = 0.25;

  setDefinitions(defs: WorldDefs): void {
    this.defs = defs;
    for (const zoneId of Object.keys(defs.zones)) {
      this._rebuildZone(zoneId);
    }
    // After all grids are built, synthesize portal entries for connections that
    // lack explicit portals. This lets the LLM write only `connections:` and skip
    // the `portals:` block for cardinal edge transitions.
    this._synthesizeConnectionPortals();
    // Wire post_ops portals (zone_connect) to their destination spawn points,
    // then auto-synthesize the matching return portals from non-cardinal connections.
    this._synthesizePostOpPortals();
    this._synthesizeReturnPortals();
  }

  /**
   * Resolve each `portal` post-op to a full ZonePortal entry pointing at the
   * target zone's spawn point. The source tile was painted during generation;
   * the destination is the target's resolved spawn point.
   */
  private _synthesizePostOpPortals(): void {
    for (const zone of Object.values(this.zones)) {
      for (const { at, toZone, transition } of zone.postOpPortals) {
        if (!this.zones[toZone]) {
          console.warn(`[world] post_op portal in '${zone.def.id}' targets unknown zone '${toZone}' — skipped.`);
          continue;
        }
        const dst = this.getZoneSpawnPoint(toZone);
        zone.def.portals = zone.def.portals ?? [];
        zone.def.portals.push({ at, to: { zone: toZone, x: dst.x, y: dst.y }, transition });
      }
    }
  }

  /**
   * For each non-cardinal connection (e.g. `surface`, `cellar`) on a zone, if no
   * portal back to the parent already exists, synthesize a return portal at this
   * zone's spawn point pointing to the parent's spawn point. This means the
   * Implementor only writes the outbound portal; the inbound is free.
   */
  private _synthesizeReturnPortals(): void {
    const CARDINAL = new Set(['north', 'south', 'east', 'west']);
    for (const [zoneId, zone] of Object.entries(this.zones)) {
      const connections = zone.def.connections ?? {};
      for (const [key, parentId] of Object.entries(connections)) {
        if (CARDINAL.has(key) || !parentId) continue;
        const parent = this.zones[parentId];
        if (!parent) continue;
        const already = (zone.def.portals ?? []).some(p => p.to?.zone === parentId);
        if (already) continue;
        const at = this.getZoneSpawnPoint(zoneId);
        // Land back on the entrance portal tile in the parent, not the focal point.
        const entrancePortal = parent.def.portals?.find(p => p.to?.zone === zoneId);
        const dst = entrancePortal?.at ?? this.getZoneSpawnPoint(parentId);
        zone.def.portals = zone.def.portals ?? [];
        zone.def.portals.push({ at, to: { zone: parentId, x: dst.x, y: dst.y }, transition: 'ascend' });
        // Paint the portal tile — generateZoneGrid ran before synthesis, so the
        // grid tile must be set directly here or the portal is invisible.
        if (zone.grid[at.y]?.[at.x] !== undefined) zone.grid[at.y]![at.x] = 'portal';
      }
    }
  }

  private _synthesizeConnectionPortals(): void {
    const OPPOSITE: Record<Direction, Direction> = {
      north: 'south', south: 'north', east: 'west', west: 'east',
    };
    for (const [zoneId, zone] of Object.entries(this.zones)) {
      for (const { at, dir, toZone: toZoneId } of zone.autoConnectionPortals) {
        const toZone = this.zones[toZoneId];
        if (!toZone) continue;
        const oppDir = OPPOSITE[dir];
        const dst = findWalkableEdgeTile(toZone.grid, toZone.width, toZone.height, oppDir, this.defs.blockingTiles);
        if (!dst) continue;
        zone.def.portals = zone.def.portals ?? [];
        zone.def.portals.push({ at, to: { zone: toZoneId, x: dst.x, y: dst.y } });
      }
    }
  }

  private _rebuildZone(zoneId: string): void {
    const def = this.defs.zones[zoneId]!;
    const prev = this.zones[zoneId];
    this.zones[zoneId] = { ...generateZoneGrid(def, this.defs.blockingTiles, this.defs.prefabs), def };

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
    const spawns = this.zones[zoneId]!.def.spawns || [];
    for (let i = 0; i < spawns.length; i++) {
      const spawn = spawns[i]!;
      if (!this.defs.mobs[spawn.entity]) continue;
      // Exact placement is a single entity; region placement scatters `count`.
      const count = spawn.at ? 1 : (spawn.count || 1);
      for (let k = 0; k < count; k++) {
        this._spawnOne(zoneId, i);
      }
    }
  }

  private _spawnOne(zoneId: string, spawnIndex: number): MobEntity | null {
    const z = this.zones[zoneId]!;
    const spawn = z.def.spawns![spawnIndex]!;
    const template = this.defs.mobs[spawn.entity];
    if (!template) return null;
    // `at` places at an exact tile (no scatter, may be a wall — sconce-style);
    // a named region scatters within it; no region at all scatters zone-wide
    // (the Implementor's coordinate-free default for zones whose generated
    // region names it cannot know).
    let pos: { x: number; y: number } | null;
    if (spawn.at) {
      pos = { x: spawn.at.x, y: spawn.at.y };
    } else if (spawn.region) {
      const region = z.bounds[spawn.region];
      if (!region) {
        if (!spawn.if_region) {
          console.warn(`[world] spawn '${spawn.entity}' in '${zoneId}' names unknown region '${spawn.region}' — skipped.`);
        }
        return null;
      }
      pos = this._findFreeTileInRegion(zoneId, region);
    } else {
      const h = z.grid.length;
      const w = z.grid[0]?.length ?? 0;
      pos = this._findFreeTileInRegion(zoneId, { x: 0, y: 0, w, h }, 60);
    }
    if (!pos) return null;
    const mob = makeMob(template, { zone: zoneId, x: pos.x, y: pos.y, spawnId: spawn.spawn_id });
    if (spawn.region) mob.components.ai.spawn_region = spawn.region;
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
        const mob = this._spawnOne(zoneId, item.spawnIndex);
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
    const grid = this.zones[zoneId]?.grid;
    for (let i = 0; i < attempts; i++) {
      const x = region.x + 1 + Math.floor(Math.random() * Math.max(1, region.w - 2));
      const y = region.y + 1 + Math.floor(Math.random() * Math.max(1, region.h - 2));
      if (grid?.[y]?.[x] === 'portal') continue;
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
      if ('focal' in sp) {
        if (z.focal) return z.focal;
      } else if ('region' in sp) {
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
    return !isBlocked(z.grid, x, y, this.defs.blockingTiles);
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
      name: z.def?.name ?? (z.def?.biome ? z.def.biome.charAt(0).toUpperCase() + z.def.biome.slice(1) : zoneId),
      width: z.width,
      height: z.height,
      grid: z.grid,
      timeOfDay: this.timeOfDay,
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
          if (mob.components.ai?.sign && mob.dialogue.length) snap.signText = mob.dialogue;
          if (mob.components.ai?.board_id) snap.boardId = `${zoneId}:${mob.components.ai.board_id}`;
          const lr = templateId ? this.defs.mobs[templateId]?.light_radius : undefined;
          if (lr) snap.lightRadius = lr;
          const ds = templateId ? this.defs.mobs[templateId]?.draw_scale : undefined;
          if (ds != null) snap.drawScale = ds;
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
