import express from 'express';
import { createServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { loadWorld } from './world/loader.ts';
import { watchWorld } from './world/watcher.ts';
import { World } from './game/world.ts';
import { GameLoop, type LoopEvent } from './game/loop.ts';
import { makePlayer, EQUIPMENT_SLOTS, CLASSES } from './game/entities.ts';
import { grantXp, allocateStat, xpForNext } from './game/systems/progress.ts';
import { dropLootFromMob, dropPlayerInventory } from './game/systems/loot.ts';
import { equipFromSlot, unequipSlot } from './game/systems/inventory.ts';
import { upsertPlayer, getPlayerBySession } from './db/index.ts';
import type {
  ClientToServerEvents, ServerToClientEvents,
  ClassId, Direction, Equipment, EquipSlot, InventoryStack, MobEntity, PlayerEntity, StatId,
} from '../shared/types.ts';
import type { PlayerRow } from './db/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WORLD_DIR = join(ROOT, 'world');
const CLIENT_DIST = join(ROOT, 'client', 'dist');

const PORT = Number(process.env.PORT) || 3000;
const STARTING_ZONE = 'starting_village';

const app = express();
const httpServer = createServer(app);
const io: IOServer<ClientToServerEvents, ServerToClientEvents> = new IOServer(httpServer);

import { existsSync } from 'node:fs';
if (existsSync(CLIENT_DIST)) app.use(express.static(CLIENT_DIST));

const world = new World();
world.setDefinitions(loadWorld(WORLD_DIR));

const loop = new GameLoop(world);
loop.onTick = (dirtyZones) => {
  for (const zoneId of dirtyZones) broadcastZone(zoneId);
};
loop.onEvents = (events: LoopEvent[]) => {
  for (const ev of events) {
    if (ev.type === 'pickup') {
      emitToEntity(ev.entityId, 'pickup', {
        kind: ev.kind,
        name: ev.name,
        amount: ev.amount,
        slot: ev.slot,
      });
      continue;
    }
    if (ev.type === 'utterance') {
      const speaker = world.entities.get(ev.entityId);
      if (speaker) {
        io.to(speaker.position.zone).emit('chat', {
          from: { id: speaker.id, name: speaker.name, type: speaker.type },
          text: ev.text,
          at: Date.now(),
        });
      }
      continue;
    }
    if (ev.type === 'zone_change') {
      const sockets = socketsByEntity.get(ev.entityId);
      if (sockets) {
        for (const sid of sockets) {
          const s = io.sockets.sockets.get(sid);
          if (!s) continue;
          s.leave(ev.from);
          s.join(ev.to);
          const snap = world.snapshotZone(ev.to);
          if (snap) s.emit('zone', snap);
        }
      }
      continue;
    }
    if (ev.type !== 'attack') continue;
    const attacker = world.entities.get(ev.attackerId);
    const target = world.entities.get(ev.targetId);
    const zoneId = target?.position.zone || attacker?.position.zone;
    if (zoneId) {
      io.to(zoneId).emit('combat', {
        attackerId: ev.attackerId,
        targetId: ev.targetId,
        damage: ev.damage,
        fatal: ev.fatal,
        dodged: ev.dodged || false,
        at: target ? { x: target.position.x, y: target.position.y } : null,
      });
    }
    if (!ev.fatal) continue;
    if (!target || !zoneId) continue;
    if (target.type === 'mob') {
      if (attacker?.type === 'player' && (target as MobEntity).xpReward) {
        const result = grantXp(attacker, (target as MobEntity).xpReward);
        emitToEntity(attacker.id, 'xp', {
          gained: (target as MobEntity).xpReward,
          xp: attacker.components.progress.xp,
          level: attacker.components.progress.level,
          xp_to_next: xpForNext(attacker.components.progress.level),
          source: { name: target.name, id: target.id },
        });
        if (result.leveled > 0) {
          emitToEntity(attacker.id, 'levelup', {
            level: result.toLevel!,
            from_level: result.fromLevel!,
            unspent_points: attacker.components.progress.unspent_points,
          });
          loop.markZoneDirty(attacker.position.zone);
        }
      }
      const drops = dropLootFromMob(world, target as MobEntity);
      if (drops.length > 0) loop.markZoneDirty(zoneId);
      world.scheduleRespawn(target as MobEntity, loop.tick);
      world.removeEntity(target.id);
      loop.markZoneDirty(zoneId);
    } else if (target.type === 'player') {
      const deathZone = target.position.zone;
      dropPlayerInventory(world, target);
      respawnPlayer(target);
      loop.markZoneDirty(deathZone);
      loop.markZoneDirty(target.position.zone);
    }
  }
};

function emitToEntity<E extends keyof ServerToClientEvents>(
  entityId: string,
  event: E,
  payload: Parameters<ServerToClientEvents[E]>[0],
): void {
  const sockets = socketsByEntity.get(entityId);
  if (!sockets) return;
  for (const sid of sockets) {
    const s = io.sockets.sockets.get(sid) as Socket<ClientToServerEvents, ServerToClientEvents> | undefined;
    // The generic constraint resolves at the call site, not here — cast to bypass.
    (s?.emit as ((e: E, p: unknown) => void) | undefined)?.(event, payload);
  }
}
loop.start();

function respawnPlayer(player: PlayerEntity): void {
  const sp = world.getZoneSpawnPoint(STARTING_ZONE);
  player.position.zone = STARTING_ZONE;
  player.position.x = sp.x;
  player.position.y = sp.y;
  player.components.health.current = player.components.health.max;
  if (player.components.progress) player.components.progress.xp = 0;
  for (const e of world.entities.values()) {
    if (e.type === 'mob' && e.components.ai?.target === player.id) e.components.ai.target = null;
  }
  const sockets = socketsByEntity.get(player.id);
  if (sockets) {
    for (const sid of sockets) {
      const s = io.sockets.sockets.get(sid);
      if (!s) continue;
      for (const room of s.rooms) {
        if (room !== sid && room !== player.position.zone) s.leave(room);
      }
      s.join(player.position.zone);
      const zone = world.snapshotZone(player.position.zone);
      if (zone) s.emit('respawn', { zone, self: player });
    }
  }
}

watchWorld(WORLD_DIR, ({ event, path }) => {
  console.log(`[world] ${event}: ${path} — reloading`);
  try {
    world.setDefinitions(loadWorld(WORLD_DIR));
    for (const e of world.entities.values()) {
      if (e.type !== 'player') continue;
      if (!world.zones[e.position.zone]) {
        const fallback = Object.keys(world.zones)[0]!;
        const sp = world.getZoneSpawnPoint(fallback);
        e.position = { zone: fallback, x: sp.x, y: sp.y };
        world.byZone.get(fallback)!.add(e.id);
      }
    }
    for (const zoneId of Object.keys(world.zones)) broadcastZone(zoneId);
  } catch (err) {
    console.error('[world] reload failed:', (err as Error).message);
  }
});

app.get('/tilesets/:name', (req, res) => {
  const ts = world.defs.tilesets[req.params.name!];
  if (!ts) { res.status(404).end(); return; }
  res.json(ts);
});

const socketsByEntity = new Map<string, Set<string>>();

const CHAT_LIMIT_COUNT = 5;
const CHAT_LIMIT_WINDOW_MS = 10_000;
const chatTimestamps = new Map<string, number[]>();
function checkChatRate(entityId: string): boolean {
  const now = Date.now();
  const arr = (chatTimestamps.get(entityId) || []).filter(t => now - t < CHAT_LIMIT_WINDOW_MS);
  if (arr.length >= CHAT_LIMIT_COUNT) {
    chatTimestamps.set(entityId, arr);
    return false;
  }
  arr.push(now);
  chatTimestamps.set(entityId, arr);
  return true;
}

io.on('connection', (socket) => {
  let entityId: string | null = null;

  socket.on('join', ({ session_token, name, klass }, ack) => {
    const token = session_token || randomUUID();
    const record = getPlayerBySession(token);
    const cleanName = sanitizeName(name);
    const pickedKlass: ClassId = klass && CLASSES[klass] ? klass : 'fighter';

    let player: PlayerEntity;
    if (record && world.zones[record.zone]) {
      player = makePlayer({
        id: record.id,
        zone: record.zone,
        x: record.x,
        y: record.y,
        name: record.name || 'Player',
        klass: record.klass || 'fighter',
      });
      player.components.progress.level = record.level ?? 1;
      player.components.progress.xp = record.xp ?? 0;
      player.components.progress.unspent_points = record.unspent_points ?? 0;
      player.components.stats.strength = record.strength ?? 5;
      player.components.stats.dexterity = record.dexterity ?? 5;
      player.components.stats.intelligence = record.intelligence ?? 5;
      player.components.stats.constitution = record.constitution ?? 5;
      const maxHp = record.max_hp ?? 100;
      player.components.health.max = maxHp;
      player.components.health.current = maxHp;
      player.components.wallet.gold = record.gold ?? 0;
      try {
        const inv = JSON.parse(record.inventory_json || '[]') as (InventoryStack | null)[];
        const slots = player.components.inventory.slots;
        for (let i = 0; i < slots.length && i < inv.length; i++) slots[i] = inv[i] || null;
        const eq = JSON.parse(record.equipment_json || '{}') as Record<string, InventoryStack | null>;
        for (const slot of EQUIPMENT_SLOTS) {
          player.components.equipment[slot] = eq[slot] || null;
        }
      } catch {/* corrupt JSON — start clean */}
    } else {
      const sp = world.getZoneSpawnPoint(STARTING_ZONE);
      player = makePlayer({
        zone: STARTING_ZONE, x: sp.x, y: sp.y,
        name: cleanName || 'Player',
        klass: pickedKlass,
      });
      upsertPlayer(playerToRow(player, token));
    }
    (player as PlayerEntity & { _sessionToken?: string })._sessionToken = token;
    world.addEntity(player);
    entityId = player.id;

    if (!socketsByEntity.has(entityId)) socketsByEntity.set(entityId, new Set());
    socketsByEntity.get(entityId)!.add(socket.id);

    socket.join(player.position.zone);

    const snap = world.snapshotZone(player.position.zone)!;
    ack?.({
      session_token: token,
      entityId,
      zone: snap,
      self: player,
    });
  });

  socket.on('action', (msg) => {
    if (!entityId) return;
    if (msg.action === 'move' && typeof msg.dir === 'string') {
      loop.enqueue({ entityId, action: 'move', dir: msg.dir as Direction });
    } else if (msg.action === 'attack') {
      loop.enqueue({ entityId, action: 'attack' });
    }
  });

  function runPlayerOp<R extends { ok: boolean; reason?: string }>(
    ack: ((r: { ok: boolean; reason?: string; self?: PlayerEntity }) => void) | undefined,
    op: (p: PlayerEntity) => R,
  ): void {
    if (!entityId) { ack?.({ ok: false, reason: 'not_joined' }); return; }
    const player = world.entities.get(entityId);
    if (!player || player.type !== 'player') { ack?.({ ok: false, reason: 'no_entity' }); return; }
    const res = op(player);
    if (res?.ok) {
      emitToEntity(entityId, 'self', { self: player });
      loop.markZoneDirty(player.position.zone);
    }
    ack?.({ ...res, self: player });
  }

  socket.on('allocate', ({ stat }, ack) => {
    runPlayerOp(ack, (player) => ({ ok: allocateStat(player, stat as StatId) }));
  });

  socket.on('equip', ({ slot }, ack) => {
    runPlayerOp(ack, (player) => equipFromSlot(player, Number(slot), world.defs));
  });

  socket.on('unequip', ({ slot }, ack) => {
    if (typeof slot !== 'string') { ack?.({ ok: false, reason: 'missing_slot' }); return; }
    runPlayerOp(ack, (player) => unequipSlot(player, slot as EquipSlot));
  });

  socket.on('chat', (msg) => {
    if (!entityId) return;
    const text = typeof msg?.text === 'string' ? msg.text.trim().slice(0, 200) : '';
    if (!text) return;
    if (!checkChatRate(entityId)) return;
    const sender = world.entities.get(entityId);
    if (!sender) return;
    io.to(sender.position.zone).emit('chat', {
      from: { id: sender.id, name: sender.name, type: sender.type },
      text,
      at: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    if (!entityId) return;
    const set = socketsByEntity.get(entityId);
    set?.delete(socket.id);
    if (set && set.size === 0) {
      const e = world.entities.get(entityId);
      if (e && e.type === 'player') {
        upsertPlayer(playerToRow(e, (e as PlayerEntity & { _sessionToken?: string })._sessionToken || randomUUID()));
        world.removeEntity(entityId);
      }
      socketsByEntity.delete(entityId);
      chatTimestamps.delete(entityId);
      if (e) loop.markZoneDirty(e.position.zone);
    }
  });
});

function sanitizeName(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 20);
  return cleaned.length > 0 ? cleaned : null;
}

function playerToRow(player: PlayerEntity, sessionToken: string): PlayerRow {
  const c = player.components;
  return {
    id: player.id,
    session_token: sessionToken,
    name: player.name || 'Player',
    klass: player.klass || 'fighter',
    zone: player.position.zone,
    x: player.position.x,
    y: player.position.y,
    level: c.progress?.level ?? 1,
    xp: c.progress?.xp ?? 0,
    max_hp: c.health?.max ?? 100,
    strength: c.stats?.strength ?? 5,
    dexterity: c.stats?.dexterity ?? 5,
    intelligence: c.stats?.intelligence ?? 5,
    constitution: c.stats?.constitution ?? 5,
    unspent_points: c.progress?.unspent_points ?? 0,
    gold: c.wallet?.gold ?? 0,
    inventory: c.inventory?.slots ?? [],
    equipment: c.equipment ?? {} as Equipment,
  };
}

function broadcastZone(zoneId: string): void {
  const snap = world.snapshotZone(zoneId);
  if (!snap) return;
  io.to(zoneId).emit('zone', snap);
}

httpServer.listen(PORT, () => {
  console.log(`[mmo] listening on http://localhost:${PORT}`);
});
