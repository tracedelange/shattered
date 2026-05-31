import express from 'express';
import { createServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { loadWorld } from './world/loader.js';
import { watchWorld } from './world/watcher.js';
import { World } from './game/world.js';
import { GameLoop } from './game/loop.js';
import { makePlayer } from './game/entities.js';
import { grantXp, allocateStat, xpForNext } from './game/systems/progress.js';
import { dropLootFromMob, dropPlayerInventory } from './game/systems/loot.js';
import { equipFromSlot, unequipSlot } from './game/systems/inventory.js';
import { upsertPlayer, getPlayerBySession } from './db/index.js';
import { EQUIPMENT_SLOTS } from './game/entities.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WORLD_DIR = join(ROOT, 'world');
const CLIENT_DIR = join(ROOT, 'client');

const PORT = Number(process.env.PORT) || 3000;
const STARTING_ZONE = 'starting_village';

// --- Boot ---
const app = express();
const httpServer = createServer(app);
const io = new IOServer(httpServer);

app.use(express.static(CLIENT_DIR));

const world = new World();
world.setDefinitions(loadWorld(WORLD_DIR));

const loop = new GameLoop(world);
loop.onTick = (dirtyZones) => {
  for (const zoneId of dirtyZones) broadcastZone(zoneId);
};
loop.onEvents = (events) => {
  for (const ev of events) {
    if (ev.type === 'pickup') {
      // No 'self' emit here — the zone broadcast at the end of this tick
      // already carries the player's updated inventory/wallet.
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
          // Direct snapshot to the moved player — they wouldn't get the
          // dirty-zone broadcast for the new room otherwise.
          s.emit('zone', world.snapshotZone(ev.to));
        }
      }
      continue;
    }
    if (ev.type !== 'attack') continue;
    const attacker = world.entities.get(ev.attackerId);
    const target = world.entities.get(ev.targetId);
    // Fan combat events out to anyone watching the zone for float-text / sfx.
    const zoneId = target?.position.zone || attacker?.position.zone;
    if (zoneId) {
      io.to(zoneId).emit('combat', {
        attackerId: ev.attackerId,
        targetId: ev.targetId,
        damage: ev.damage,
        fatal: ev.fatal,
        at: target ? { x: target.position.x, y: target.position.y } : null,
      });
    }
    if (!ev.fatal) continue;
    if (!target) continue;
    if (target.type === 'mob') {
      // Award XP to the killer if they're a player.
      if (attacker?.type === 'player' && target.xpReward) {
        const result = grantXp(attacker, target.xpReward);
        emitToEntity(attacker.id, 'xp', {
          gained: target.xpReward,
          xp: attacker.components.progress.xp,
          level: attacker.components.progress.level,
          xp_to_next: xpForNext(attacker.components.progress.level),
          source: { name: target.name, id: target.id },
        });
        if (result.leveled > 0) {
          emitToEntity(attacker.id, 'levelup', {
            level: result.toLevel,
            from_level: result.fromLevel,
            unspent_points: attacker.components.progress.unspent_points,
          });
          loop.markZoneDirty(attacker.position.zone);
        }
      }
      // Roll loot before removing — drops use the mob's death position.
      const drops = dropLootFromMob(world, target);
      if (drops.length > 0) loop.markZoneDirty(zoneId);
      world.scheduleRespawn(target, loop.tick);
      world.removeEntity(target.id);
      loop.markZoneDirty(zoneId);
    } else if (target.type === 'player') {
      // Drop everything on the death tile before respawn moves them away.
      const deathZone = target.position.zone;
      dropPlayerInventory(world, target);
      respawnPlayer(target);
      loop.markZoneDirty(deathZone);            // show the dropped pile
      loop.markZoneDirty(target.position.zone); // show the player at spawn
    }
  }
};

function emitToEntity(entityId, event, payload) {
  const sockets = socketsByEntity.get(entityId);
  if (!sockets) return;
  for (const sid of sockets) {
    io.sockets.sockets.get(sid)?.emit(event, payload);
  }
}
loop.start();

function respawnPlayer(player) {
  const sp = world.getZoneSpawnPoint(STARTING_ZONE);
  // Move them back to spawn, clear any AI targets that pointed at them.
  player.position.zone = STARTING_ZONE;
  player.position.x = sp.x;
  player.position.y = sp.y;
  player.components.health.current = player.components.health.max;
  // Reset XP to the floor of the current level — level and unspent points stick.
  if (player.components.progress) player.components.progress.xp = 0;
  for (const e of world.entities.values()) {
    if (e.components?.ai?.target === player.id) e.components.ai.target = null;
  }
  // Re-route socket rooms so the player only gets snapshots for their new zone.
  const sockets = socketsByEntity.get(player.id);
  if (sockets) {
    for (const sid of sockets) {
      const s = io.sockets.sockets.get(sid);
      if (!s) continue;
      for (const room of s.rooms) {
        if (room !== sid && room !== player.position.zone) s.leave(room);
      }
      s.join(player.position.zone);
      s.emit('respawn', { zone: world.snapshotZone(player.position.zone), self: player });
    }
  }
}

watchWorld(WORLD_DIR, ({ event, path }) => {
  console.log(`[world] ${event}: ${path} — reloading`);
  try {
    world.setDefinitions(loadWorld(WORLD_DIR));
    // Reattach players to a valid zone if their zone vanished.
    for (const e of world.entities.values()) {
      if (e.type !== 'player') continue;
      if (!world.zones[e.position.zone]) {
        const fallback = Object.keys(world.zones)[0];
        const sp = world.getZoneSpawnPoint(fallback);
        e.position = { zone: fallback, x: sp.x, y: sp.y };
        world.byZone.get(fallback).add(e.id);
      }
    }
    for (const zoneId of Object.keys(world.zones)) broadcastZone(zoneId);
  } catch (err) {
    console.error('[world] reload failed:', err.message);
  }
});

// --- Tileset endpoint (client needs colors for rendering) ---
app.get('/tilesets/:name', (req, res) => {
  const ts = world.defs.tilesets[req.params.name];
  if (!ts) return res.status(404).end();
  res.json(ts);
});

// --- Socket lifecycle ---
const socketsByEntity = new Map(); // entityId -> Set<socket.id>

// Chat rate limit: 5 messages per 10s per entity.
const CHAT_LIMIT_COUNT = 5;
const CHAT_LIMIT_WINDOW_MS = 10_000;
const chatTimestamps = new Map(); // entityId -> number[]
function checkChatRate(entityId) {
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
  let entityId = null;

  socket.on('join', ({ session_token, name }, ack) => {
    const token = session_token || randomUUID();
    let record = getPlayerBySession(token);
    const cleanName = sanitizeName(name);

    if (record && world.zones[record.zone]) {
      const player = makePlayer({
        id: record.id,
        zone: record.zone,
        x: record.x,
        y: record.y,
        name: record.name || 'Player',
      });
      // Restore persisted progress.
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
        const inv = JSON.parse(record.inventory_json || '[]');
        const slots = player.components.inventory.slots;
        for (let i = 0; i < slots.length && i < inv.length; i++) slots[i] = inv[i] || null;
        const eq = JSON.parse(record.equipment_json || '{}');
        for (const slot of EQUIPMENT_SLOTS) {
          player.components.equipment[slot] = eq[slot] || null;
        }
      } catch (_e) {/* corrupt JSON — start clean */}
      player._sessionToken = token;
      world.addEntity(player);
      entityId = player.id;
    } else {
      const sp = world.getZoneSpawnPoint(STARTING_ZONE);
      const player = makePlayer({
        zone: STARTING_ZONE, x: sp.x, y: sp.y,
        name: cleanName || 'Player',
      });
      player._sessionToken = token;
      world.addEntity(player);
      entityId = player.id;
      upsertPlayer(playerToRow(player, token));
    }

    if (!socketsByEntity.has(entityId)) socketsByEntity.set(entityId, new Set());
    socketsByEntity.get(entityId).add(socket.id);

    const entity = world.entities.get(entityId);
    socket.join(entity.position.zone);

    ack?.({
      session_token: token,
      entityId,
      zone: world.snapshotZone(entity.position.zone),
      self: entity,
    });
  });

  socket.on('action', (msg) => {
    if (!entityId) return;
    if (msg?.action === 'move' && typeof msg.dir === 'string') {
      loop.enqueue({ entityId, action: 'move', dir: msg.dir });
    } else if (msg?.action === 'attack') {
      loop.enqueue({ entityId, action: 'attack' });
    }
  });

  function runPlayerOp(ack, op) {
    if (!entityId) return ack?.({ ok: false, reason: 'not_joined' });
    const player = world.entities.get(entityId);
    if (!player) return ack?.({ ok: false, reason: 'no_entity' });
    const res = op(player);
    if (res?.ok) {
      emitToEntity(entityId, 'self', { self: player });
      loop.markZoneDirty(player.position.zone);
    }
    ack?.({ ...res, self: player });
  }

  socket.on('allocate', ({ stat } = {}, ack) => {
    runPlayerOp(ack, (player) => ({ ok: allocateStat(player, stat) }));
  });

  socket.on('equip', ({ slot } = {}, ack) => {
    runPlayerOp(ack, (player) => equipFromSlot(player, Number(slot), world.defs));
  });

  socket.on('unequip', ({ slot } = {}, ack) => {
    if (typeof slot !== 'string') return ack?.({ ok: false, reason: 'missing_slot' });
    runPlayerOp(ack, (player) => unequipSlot(player, slot));
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
      if (e) {
        upsertPlayer(playerToRow(e, e._sessionToken || randomUUID()));
        world.removeEntity(entityId);
      }
      socketsByEntity.delete(entityId);
      chatTimestamps.delete(entityId);
      loop.markZoneDirty(e?.position.zone);
    }
  });
});

function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  // Letters, numbers, spaces, hyphens, underscores; 1-20 chars after trim.
  const cleaned = raw.trim().replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 20);
  return cleaned.length > 0 ? cleaned : null;
}

function playerToRow(player, sessionToken) {
  const c = player.components;
  return {
    id: player.id,
    session_token: sessionToken,
    name: player.name || 'Player',
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
    equipment: c.equipment ?? {},
  };
}

function broadcastZone(zoneId) {
  const snap = world.snapshotZone(zoneId);
  if (!snap) return;
  io.to(zoneId).emit('zone', snap);
}

httpServer.listen(PORT, () => {
  console.log(`[mmo] listening on http://localhost:${PORT}`);
});
