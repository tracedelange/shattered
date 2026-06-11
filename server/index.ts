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
import {
  upsertAccount, upsertCharacter, getActiveCharacter, getCharacterById,
  getCharactersByAccount, setActiveCharacter,
  countCharacters, saveCharacters, closeDb,
  getBoardMessages, postBoardMessage,
  type CharacterRow, type StoredCharacterRow,
} from './db/index.ts';
import { verifyFirebaseToken } from './auth.ts';
import {
  buildGiverIndex, handleQuestAction, notifyKill, notifyMove, notifyPickup,
} from './game/systems/quests.ts';
import { getCommand, parseCommand } from './game/systems/commands.ts';
import type {
  CharacterSummary,
  ClientToServerEvents, ServerToClientEvents,
  ClassId, CorpseEntity, Direction, Equipment, EquipSlot, InventoryStack,
  LootCorpseResponse, LootSlot, MobEntity, PlayerEntity,
  PostBoardResponse, ReadBoardResponse,
  QuestsComponent, StatId, TradeMessage, TradeResponse, UseItemResponse,
} from '../shared/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WORLD_DIR = join(ROOT, 'world');
const CLIENT_DIST = join(ROOT, 'client', 'dist');

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN?.split(',') ?? ['http://localhost:5173']
export const PREFERRED_STARTING_ZONE = 'village_41_41';
// Resolve the spawn zone at call time: the preferred zone if it's loaded, else
// the first available zone. Prevents null/missing-zone spawns when the world
// changes (e.g. a clean-slate rebuild removed the old starting zone).
function startingZone(): string {
  if (world.zones[PREFERRED_STARTING_ZONE]) return PREFERRED_STARTING_ZONE;
  const first = Object.keys(world.zones)[0];
  if (!first) throw new Error('No zones loaded — cannot place a player.');
  return first;
}
const RESPAWN_DELAY_MS = 10_000;

const app = express();
const httpServer = createServer(app);
const io: IOServer<ClientToServerEvents, ServerToClientEvents> = new IOServer(httpServer, {
  cors: { origin: CLIENT_ORIGIN },
});

import { existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CLIENT_ORIGIN.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  next();
});

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
      if (ev.kind === 'item' && ev.base) {
        const player = world.entities.get(ev.entityId);
        if (player && player.type === 'player') {
          const r = notifyPickup(player, world.defs.quests, ev.base, 1);
          emitQuestRewards(player, r);
        }
      }
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
    if (ev.type === 'player_moved') {
      const player = world.entities.get(ev.entityId);
      if (player && player.type === 'player') {
        const r = notifyMove(player, world.defs.quests, world);
        emitQuestRewards(player, r);
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
      // Natural checkpoint: persist on every zone transition.
      const meta = playerMeta.get(ev.entityId);
      const player = world.entities.get(ev.entityId);
      if (meta && player && player.type === 'player') {
        try { upsertCharacter(characterToRow(player, meta.accountId, meta.characterId, meta.slot)); }
        catch (err) { console.error('[zone_change] save failed:', (err as Error).message); }
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
      if (attacker?.type === 'player') {
        const r = notifyKill(attacker, world.defs.quests, target as MobEntity);
        emitQuestRewards(attacker, r);
      }
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
          io.emit('chat', {
            from: { id: 'system', name: 'System', type: 'player' as const },
            text: `${attacker.name} has reached level ${result.toLevel}!`,
            at: Date.now(),
            channel: 'system',
          });
          loop.markZoneDirty(attacker.position.zone);
        }
      }
      dropLootFromMob(world, target as MobEntity, attacker?.type === 'player' ? attacker : null);
      world.scheduleRespawn(target as MobEntity, loop.tick);
      world.removeEntity(target.id);
      loop.markZoneDirty(zoneId);
    } else if (target.type === 'player') {
      const deathZone = target.position.zone;
      dropPlayerInventory(world, target);
      movePlayerToRespawn(target);
      emitToEntity(target.id, 'died', {});
      io.emit('chat', {
        from: { id: 'system', name: 'System', type: 'player' as const },
        text: `${target.name} has fallen!`,
        at: Date.now(),
        channel: 'system',
      });
      loop.markZoneDirty(deathZone);
      loop.markZoneDirty(target.position.zone);
      const dyingPlayer = target;
      setTimeout(() => sendRespawnEvent(dyingPlayer), RESPAWN_DELAY_MS);
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

import type { NotifyResult } from './game/systems/quests.ts';
function emitQuestRewards(player: PlayerEntity, r: NotifyResult): void {
  if (!r.changed) return;
  emitToEntity(player.id, 'quests', { quests: player.components.quests });
  if (r.rewardsGranted.gold || r.rewardsGranted.items.length || r.rewardsGranted.xp) {
    emitToEntity(player.id, 'self', { self: player });
  }
  if (r.rewardsGranted.xp) {
    emitToEntity(player.id, 'xp', {
      gained: r.rewardsGranted.xp,
      xp: player.components.progress.xp,
      level: player.components.progress.level,
      xp_to_next: xpForNext(player.components.progress.level),
      source: { name: 'Quest', id: '' },
    });
  }
  if (r.rewardsGranted.leveled > 0) {
    emitToEntity(player.id, 'levelup', {
      level: r.rewardsGranted.toLevel!,
      from_level: r.rewardsGranted.fromLevel!,
      unspent_points: player.components.progress.unspent_points,
    });
    io.emit('chat', {
      from: { id: 'system', name: 'System', type: 'player' as const },
      text: `${player.name} has reached level ${r.rewardsGranted.toLevel}!`,
      at: Date.now(),
      channel: 'system',
    });
  }
}

function movePlayerToRespawn(player: PlayerEntity): void {
  const sz = startingZone();
  const sp = world.getZoneSpawnPoint(sz);
  player.position.zone = sz;
  player.position.x = sp.x;
  player.position.y = sp.y;
  player.components.health.current = player.components.health.max;
  if (player.components.progress) {
    // Lose 25% of current-level XP progress on death
    player.components.progress.xp = Math.floor(player.components.progress.xp * 0.75);
  }
  for (const e of world.entities.values()) {
    if (e.type === 'mob' && e.components.ai?.target === player.id) e.components.ai.target = null;
  }
}

function sendRespawnEvent(player: PlayerEntity): void {
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
    giverIndexCache = null;
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

let giverIndexCache: Record<string, string[]> | null = null;
function getGiverIndex(): Record<string, string[]> {
  if (!giverIndexCache) giverIndexCache = buildGiverIndex(world.defs.quests);
  return giverIndexCache;
}

app.get('/tilesets/:name', (req, res) => {
  const ts = world.defs.tilesets[req.params.name!];
  if (!ts) { res.status(404).end(); return; }
  res.json(ts);
});

app.get('/api/quests', (_req, res) => {
  res.json({ defs: world.defs.quests, byGiver: getGiverIndex() });
});

app.get('/api/shop/:templateId', (req, res) => {
  const template = world.defs.mobs[req.params.templateId!];
  if (!template?.shop?.length) { res.status(404).json({ items: [] }); return; }
  const items = template.shop.map((entry) => {
    const base = world.defs.itemBases[entry.item];
    return { item: entry.item, price: entry.price, name: base?.name ?? entry.item, sprite: base?.sprite ?? 'item_misc' };
  });
  res.json({ items });
});

const ZONE_COORD_RE = /^(zone|city|village)_(\d+)_(\d+)$/;

app.get('/api/world-map', (_req, res) => {
  const zonesDir = join(WORLD_DIR, 'zones');
  const zones: { id: string; name: string; biome: string | null; gridX: number; gridY: number; type: string }[] = [];

  try {
    for (const file of readdirSync(zonesDir)) {
      if (extname(file) !== '.json') continue;
      try {
        const zone = JSON.parse(readFileSync(join(zonesDir, file), 'utf8')) as Record<string, unknown>;
        const m = ZONE_COORD_RE.exec(String(zone.id ?? ''));
        if (!m) continue;
        zones.push({
          id:    String(zone.id),
          name:  String(zone.name ?? zone.id),
          biome: zone.biome != null ? String(zone.biome) : null,
          gridX: parseInt(m[2]!, 10),
          gridY: parseInt(m[3]!, 10),
          type:  m[1]!,
        });
      } catch { /* skip malformed files */ }
    }
  } catch { /* zones dir missing */ }

  if (!zones.length) {
    res.json({ cols: 0, rows: 0, cells: [], settlements: [] });
    return;
  }

  const maxX = Math.max(...zones.map(z => z.gridX));
  const maxY = Math.max(...zones.map(z => z.gridY));
  const cols = maxX + 1;
  const rows = maxY + 1;

  const cells: (null | { worldBiome: string; zoneName: string; zoneId: string })[][] =
    Array.from({ length: rows }, () => Array(cols).fill(null));
  const settlements: { type: string; gridX: number; gridY: number; name: string }[] = [];

  for (const z of zones) {
    cells[z.gridY]![z.gridX] = { worldBiome: z.biome ?? 'plains', zoneName: z.name, zoneId: z.id };
    if (z.type === 'city' || z.type === 'village') {
      settlements.push({ type: z.type, gridX: z.gridX, gridY: z.gridY, name: z.name });
    }
  }

  res.json({ cols, rows, cells, settlements });
});

app.get('/api/players', (_req, res) => {
  const players: { id: string; name: string; zone: string; level: number; klass: string }[] = [];
  for (const [entityId] of playerMeta) {
    const e = world.entities.get(entityId);
    if (!e || e.type !== 'player') continue;
    players.push({
      id: entityId,
      name: e.name,
      zone: e.position.zone,
      level: e.components.progress?.level ?? 1,
      klass: e.klass,
    });
  }
  res.json({ players });
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

const BOARD_POST_COOLDOWN_MS = 60_000;
const boardPostLastAt = new Map<string, number>();

// Per-entity server-only metadata. Kept out of PlayerEntity so it never leaks
// over the wire via snapshots or the `self` event.
interface PlayerMeta { accountId: string; characterId: string; slot: 1 | 2 | 3 }
const playerMeta = new Map<string, PlayerMeta>();

// --- Persistence: periodic autosave + graceful shutdown -------------------

const AUTOSAVE_INTERVAL_MS = Number(process.env.MMO_AUTOSAVE_INTERVAL_MS) || 30_000;

function snapshotOnlinePlayers(): CharacterRow[] {
  const rows: CharacterRow[] = [];
  for (const [entityId, meta] of playerMeta) {
    const e = world.entities.get(entityId);
    if (!e || e.type !== 'player') continue;
    rows.push(characterToRow(e, meta.accountId, meta.characterId, meta.slot));
  }
  return rows;
}

function flushOnlinePlayers(): number {
  const rows = snapshotOnlinePlayers();
  if (rows.length === 0) return 0;
  try { saveCharacters(rows); } catch (err) {
    console.error('[autosave] flush failed:', (err as Error).message);
    return 0;
  }
  return rows.length;
}

const autosaveTimer = setInterval(flushOnlinePlayers, AUTOSAVE_INTERVAL_MS);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(autosaveTimer);
  const n = flushOnlinePlayers();
  console.log(`[mmo] ${signal} received — flushed ${n} player(s), closing.`);
  try { closeDb(); } catch (err) { console.error('[shutdown] db close failed:', err); }
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));

let restarting = false;
async function broadcastCountdownAndRestart(): Promise<void> {
  if (restarting || shuttingDown) return;
  restarting = true;
  clearInterval(autosaveTimer);

  const sysChat = (text: string) => io.emit('chat', {
    from: { id: 'system', name: 'System', type: 'player' as const },
    text,
    at: Date.now(),
  });

  sysChat('Server is restarting in 10 seconds...');
  for (let i = 9; i > 0; i--) {
    await new Promise<void>(r => setTimeout(r, 1000));
    sysChat(`${i}...`);
  }
  await new Promise<void>(r => setTimeout(r, 1000));

  const n = flushOnlinePlayers();
  console.log(`[restart] flushed ${n} player(s)`);
  io.disconnectSockets(true);
  try { closeDb(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGUSR2', () => { void broadcastCountdownAndRestart(); });

io.on('connection', (socket) => {
  let entityId: string | null = null;

  socket.on('list_characters', (req, ack) => {
    void (async () => {
      try {
        let uid: string;
        let email: string | null;
        try {
          ({ uid, email } = await verifyFirebaseToken(req.firebase_token));
        } catch (err) {
          ack?.({ characters: [], error: `Auth failed: ${(err as Error).message}` });
          return;
        }
        upsertAccount({ firebase_uid: uid, email });
        const rows = getCharactersByAccount(uid);
        const characters: CharacterSummary[] = rows.map((r) => ({
          id: r.id,
          slot: r.slot,
          name: r.name,
          klass: r.klass,
          color: r.color,
          level: r.level,
          zone: r.zone,
        }));
        ack?.({ characters });
      } catch (err) {
        ack?.({ characters: [], error: 'Internal server error.' });
        console.error('[list_characters]', err);
      }
    })();
  });

  socket.on('join', (req, ack) => {
    void (async () => {
      try {
        // --- Firebase token verification ---
        let uid: string;
        let email: string | null;
        try {
          ({ uid, email } = await verifyFirebaseToken(req.firebase_token));
        } catch (err) {
          console.error('[auth] verifyFirebaseToken failed:', (err as Error).message);
          ack?.({ entityId: '', error: `Auth verification failed: ${(err as Error).message}` });
          return;
        }
        console.log('[auth] verified uid=%s email=%s', uid, email);

        // --- Ensure account row exists ---
        upsertAccount({ firebase_uid: uid, email });

        // --- Switch to a specific character if requested ---
        if (req.character_id) {
          setActiveCharacter(uid, req.character_id);
        }

        // --- Resolve or create character ---
        let record: StoredCharacterRow | undefined = getActiveCharacter(uid);

        if (!record) {
          if (!req.name) {
            // First-time user, no name yet — tell client to show character creation
            ack?.({ entityId: '', needsCharacter: true });
            return;
          }
          const newId = randomUUID();
          const sz = startingZone();
          const sp = world.getZoneSpawnPoint(sz);
          const cleanName = sanitizeName(req.name) || 'Hero';
          const pickedKlass: ClassId = req.klass && CLASSES[req.klass] ? req.klass : 'fighter';
          const pickedColor = /^#[0-9a-fA-F]{6}$/.test(req.color ?? '') ? req.color! : '#6ec6f0';
          upsertCharacter({
            id: newId,
            account_id: uid,
            slot: (countCharacters(uid) + 1) as 1 | 2 | 3,
            is_active: 1,
            name: cleanName,
            klass: pickedKlass,
            color: pickedColor,
            zone: sz,
            x: sp.x,
            y: sp.y,
          });
          record = getCharacterById(newId)!;
        }

        // --- Reconstruct or create PlayerEntity ---
        let player: PlayerEntity;
        if (world.zones[record.zone]) {
          player = makePlayer({
            id: record.id,
            zone: record.zone,
            x: record.x,
            y: record.y,
            name: record.name,
            klass: record.klass,
          });
          player.color = record.color || '#6ec6f0';
          player.components.progress.level          = record.level;
          player.components.progress.xp             = record.xp;
          player.components.progress.unspent_points = record.unspent_points;
          player.components.stats.strength          = record.strength;
          player.components.stats.dexterity         = record.dexterity;
          player.components.stats.intelligence      = record.intelligence;
          player.components.stats.constitution      = record.constitution;
          const maxHp = record.max_hp;
          player.components.health.max     = maxHp;
          player.components.health.current = maxHp;
          player.components.wallet.gold = record.gold;
          try {
            const inv = JSON.parse(record.inventory_json || '[]') as (InventoryStack | null)[];
            const slots = player.components.inventory.slots;
            for (let i = 0; i < slots.length && i < inv.length; i++) slots[i] = inv[i] || null;
            const eq = JSON.parse(record.equipment_json || '{}') as Record<string, InventoryStack | null>;
            for (const slot of EQUIPMENT_SLOTS) player.components.equipment[slot] = eq[slot] || null;
            const q = JSON.parse(record.quests_json || '{"active":[],"completed":[]}') as QuestsComponent;
            player.components.quests = {
              active:    Array.isArray(q.active)    ? q.active    : [],
              completed: Array.isArray(q.completed) ? q.completed : [],
            };
          } catch {/* corrupt JSON — start clean */}
        } else {
          const sz = startingZone();
          const sp = world.getZoneSpawnPoint(sz);
          player = makePlayer({
            id: record.id,
            zone: sz, x: sp.x, y: sp.y,
            name: record.name, klass: record.klass,
          });
          player.color = record.color || '#6ec6f0';
        }

        world.addEntity(player);
        entityId = player.id;
        playerMeta.set(entityId, {
          accountId:   uid,
          characterId: record.id,
          slot:        record.slot as 1 | 2 | 3,
        });

        if (!socketsByEntity.has(entityId)) socketsByEntity.set(entityId, new Set());
        socketsByEntity.get(entityId)!.add(socket.id);
        socket.join(player.position.zone);

        const snap = world.snapshotZone(player.position.zone);
        if (!snap) {
          console.error(`[join] no snapshot for zone '${player.position.zone}' — aborting join`);
          ack?.({ entityId: '', error: `Spawn zone '${player.position.zone}' is unavailable.` });
          return;
        }
        ack?.({ entityId, zone: snap, self: player });
        socket.emit('quests', { quests: player.components.quests });
      } catch (err) {
        console.error('[join] unexpected error:', err);
        ack?.({ entityId: '', error: 'Internal server error.' });
      }
    })();
  });

  socket.on('quest_action', ({ questId, action, talkingTo }, ack) => {
    if (!entityId) { ack?.({ ok: false, reason: 'not_joined' }); return; }
    const player = world.entities.get(entityId);
    if (!player || player.type !== 'player') { ack?.({ ok: false, reason: 'no_entity' }); return; }
    if (typeof questId !== 'string' || typeof action !== 'string') {
      ack?.({ ok: false, reason: 'bad_args' }); return;
    }
    const beforeGold = player.components.wallet.gold;
    const beforeXp = player.components.progress.xp;
    const beforeLevel = player.components.progress.level;
    const result = handleQuestAction(
      player, world.defs.quests, questId, action,
      { talkingTo: typeof talkingTo === 'string' ? talkingTo : undefined, world },
    );
    if (result.ok) {
      socket.emit('quests', { quests: player.components.quests });
      const xpGained = player.components.progress.xp - beforeXp +
        (player.components.progress.level - beforeLevel) * 100; // rough: handles level-up xp reset
      if (player.components.wallet.gold !== beforeGold || xpGained > 0) {
        socket.emit('self', { self: player });
      }
      if (xpGained > 0) {
        socket.emit('xp', {
          gained: xpGained,
          xp: player.components.progress.xp,
          level: player.components.progress.level,
          xp_to_next: xpForNext(player.components.progress.level),
          source: { name: 'Quest', id: '' },
        });
      }
      if (player.components.progress.level > beforeLevel) {
        socket.emit('levelup', {
          level: player.components.progress.level,
          from_level: beforeLevel,
          unspent_points: player.components.progress.unspent_points,
        });
      }
    }
    ack?.(result);
  });

  socket.on('action', (msg) => {
    if (!entityId) return;
    if (msg.action === 'move' && typeof msg.dir === 'string') {
      loop.enqueue({ entityId, action: 'move', dir: msg.dir as Direction });
    } else if (msg.action === 'attack') {
      loop.enqueue({ entityId, action: 'attack' });
    } else if (msg.action === 'autopath' && typeof msg.tx === 'number' && typeof msg.ty === 'number') {
      loop.enqueue({ entityId, action: 'autopath', tx: msg.tx | 0, ty: msg.ty | 0 });
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

    const toSender = (line: string) => socket.emit('chat', {
      from: { id: 'system', name: 'System', type: 'player' as const },
      text: line, at: Date.now(),
    });

    const cmd = parseCommand(text);
    if (cmd) {
      if (sender.type !== 'player') return;
      const def = getCommand(cmd.name);
      if (!def) { toSender(`Unknown command: /${cmd.name}`); return; }
      const result = def.handler({ player: sender, world, args: cmd.args });
      if (result.error) { toSender(result.error); return; }
      if (result.message) toSender(result.message);
      if (result.openMap) socket.emit('open_map');
      if (result.teleported) {
        const { fromZone, toZone } = result.teleported;
        for (const room of socket.rooms) {
          if (room !== socket.id && room !== toZone) socket.leave(room);
        }
        socket.join(toZone);
        const snap = world.snapshotZone(toZone);
        if (snap) socket.emit('zone', snap);
        loop.markZoneDirty(fromZone);
        loop.markZoneDirty(toZone);
      }
      return;
    }

    // Global channel: /g <message>
    if (/^\/g(?:lobal)? /i.test(text)) {
      const body = text.replace(/^\/g(?:lobal)? /i, '').trim();
      if (!body) return;
      io.emit('chat', {
        from: { id: sender.id, name: sender.name, type: sender.type },
        text: body, at: Date.now(), channel: 'global' as const,
      });
      return;
    }

    // Whisper: /w <name> <message>
    if (/^\/w(?:hisper)? /i.test(text)) {
      const rest = text.replace(/^\/w(?:hisper)? /i, '');
      const space = rest.indexOf(' ');
      if (space === -1) { toSender('Usage: /w <name> <message>'); return; }
      const targetName = rest.slice(0, space).toLowerCase();
      const body = rest.slice(space + 1).trim();
      if (!body) return;

      let targetId: string | null = null;
      for (const [eid] of playerMeta) {
        const e = world.entities.get(eid);
        if (e && e.name.toLowerCase() === targetName) { targetId = eid; break; }
      }
      if (!targetId) { toSender(`Player "${rest.slice(0, space)}" not found or offline.`); return; }
      if (targetId === entityId) { toSender('You cannot whisper to yourself.'); return; }

      const targetEntity = world.entities.get(targetId)!;
      const from = { id: sender.id, name: sender.name, type: sender.type };
      const at = Date.now();

      // Deliver to target
      emitToEntity(targetId, 'chat', { from, text: body, at, channel: 'whisper' as const });
      // Echo to sender so they see what they sent
      socket.emit('chat', { from, text: `(to ${targetEntity.name}) ${body}`, at, channel: 'whisper' as const });
      return;
    }

    io.to(sender.position.zone).emit('chat', {
      from: { id: sender.id, name: sender.name, type: sender.type },
      text,
      at: Date.now(),
    });
  });

  socket.on('poke_mob', ({ mobId }) => {
    if (!entityId) return;
    const player = world.entities.get(entityId);
    if (!player) return;
    const mob = world.entities.get(mobId);
    if (!mob || mob.type !== 'mob') return;
    if (mob.position.zone !== player.position.zone) return;
    if ((mob.components.health?.current ?? 0) <= 0) return;
    const lines = mob.dialogue;
    if (!lines || lines.length === 0) return;
    const text = lines[Math.floor(Math.random() * lines.length)]!;
    io.to(mob.position.zone).emit('chat', {
      from: { id: mob.id, name: mob.name, type: mob.type },
      text,
      at: Date.now(),
    });
  });

  socket.on('trade', (msg: TradeMessage, ack: (r: TradeResponse) => void) => {
    if (!entityId) return ack({ ok: false, reason: 'not_joined' });
    const player = world.entities.get(entityId);
    if (!player || player.type !== 'player') return ack({ ok: false, reason: 'not_player' });

    const mob = world.entities.get(msg.mobId);
    if (!mob || mob.type !== 'mob') return ack({ ok: false, reason: 'no_mob' });
    if (mob.position.zone !== player.position.zone) return ack({ ok: false, reason: 'out_of_range' });
    const dist = Math.max(Math.abs(player.position.x - mob.position.x), Math.abs(player.position.y - mob.position.y));
    if (dist > 2) return ack({ ok: false, reason: 'out_of_range' });

    const template = world.defs.mobs[mob.components.ai?.template_id ?? ''];
    if (!template?.shop?.length) return ack({ ok: false, reason: 'no_shop' });

    if (msg.action === 'buy') {
      const entry = template.shop.find((s) => s.item === msg.itemBase);
      if (!entry) return ack({ ok: false, reason: 'not_for_sale' });
      const base = world.defs.itemBases[entry.item];
      if (!base) return ack({ ok: false, reason: 'unknown_item' });
      const wallet = player.components.wallet;
      if (wallet.gold < entry.price) return ack({ ok: false, reason: 'insufficient_gold' });
      const slots = player.components.inventory.slots;
      const freeSlot = slots.findIndex((s) => !s);
      if (freeSlot === -1) return ack({ ok: false, reason: 'inventory_full' });
      wallet.gold -= entry.price;
      slots[freeSlot] = { base: entry.item, item: null, name: base.name || entry.item, sprite: base.sprite || 'item_misc', sell_value: base.sell_value, item_slot: base.slot };
      emitToEntity(entityId, 'self', { self: player });
      return ack({ ok: true, self: player });
    }

    if (msg.action === 'sell') {
      if (typeof msg.slotIndex !== 'number') return ack({ ok: false, reason: 'no_slot' });
      const slots = player.components.inventory.slots;
      const stack = slots[msg.slotIndex];
      if (!stack) return ack({ ok: false, reason: 'empty_slot' });
      const base = world.defs.itemBases[stack.base];
      if (!base || base.slot === 'quest' || base.slot === 'currency') return ack({ ok: false, reason: 'cannot_sell' });
      const sellPrice = Math.max(1, base.sell_value ?? 0);
      player.components.wallet.gold += sellPrice;
      slots[msg.slotIndex] = null;
      emitToEntity(entityId, 'self', { self: player });
      return ack({ ok: true, self: player });
    }

    ack({ ok: false, reason: 'unknown_action' });
  });

  socket.on('use_item', (msg, ack: (r: UseItemResponse) => void) => {
    if (!entityId) return ack({ ok: false, reason: 'not_joined' });
    const player = world.entities.get(entityId);
    if (!player || player.type !== 'player') return ack({ ok: false, reason: 'not_player' });

    const slots = player.components.inventory.slots;
    const stack = slots[msg.slot];
    if (!stack) return ack({ ok: false, reason: 'empty_slot' });

    const base = world.defs.itemBases[stack.base];
    if (!base?.use_effect) return ack({ ok: false, reason: 'not_usable' });

    let healed = 0;
    if (base.use_effect.heal !== undefined) {
      const h = base.use_effect.heal;
      const amount = Array.isArray(h)
        ? h[0] + Math.floor(Math.random() * (h[1] - h[0] + 1))
        : h;
      const health = player.components.health;
      const prev = health.current;
      health.current = Math.min(health.max, health.current + amount);
      healed = health.current - prev;
    }

    slots[msg.slot] = null;
    emitToEntity(entityId, 'self', { self: player });
    loop.markZoneDirty(player.position.zone);
    return ack({ ok: true, self: player, healed });
  });

  socket.on('loot_corpse', (msg, ack: (r: LootCorpseResponse) => void) => {
    if (!entityId) return ack({ ok: false, reason: 'not_joined' });
    const corpseEntity = world.entities.get(msg.corpseId);
    if (!corpseEntity || corpseEntity.type !== 'corpse') return ack({ ok: false, reason: 'not_found' });
    const corpse = corpseEntity as CorpseEntity;
    const playerEntity = world.entities.get(entityId);
    if (!playerEntity || playerEntity.type !== 'player') return ack({ ok: false, reason: 'not_player' });
    const player: PlayerEntity = playerEntity;
    const dist = Math.max(
      Math.abs(player.position.x - corpse.position.x),
      Math.abs(player.position.y - corpse.position.y),
    );
    if (dist > 2) return ack({ ok: false, reason: 'too_far' });

    function takeSlot(slot: LootSlot): boolean {
      if (slot.gold > 0) {
        player.components.wallet.gold += slot.gold;
        return true;
      }
      if (slot.item) {
        const inv = player.components.inventory.slots;
        const freeIdx = inv.findIndex((s: InventoryStack | null) => s === null);
        if (freeIdx === -1) return false;
        const base = world.defs.itemBases[slot.base];
        inv[freeIdx] = { base: slot.base, item: slot.item, name: slot.name, sprite: base?.sprite || 'item_misc' };
        return true;
      }
      return true;
    }

    if (msg.slotId === 'all') {
      const remaining: LootSlot[] = [];
      for (const slot of corpse.loot) {
        if (!takeSlot(slot)) remaining.push(slot);
      }
      corpse.loot = remaining;
    } else {
      const idx = corpse.loot.findIndex((s) => s.id === msg.slotId);
      if (idx === -1) return ack({ ok: false, reason: 'slot_not_found' });
      if (!takeSlot(corpse.loot[idx]!)) return ack({ ok: false, reason: 'inventory_full' });
      corpse.loot.splice(idx, 1);
    }

    if (corpse.loot.length === 0) loop.corpseEmptiedTick.set(corpse.id, loop.tick);
    loop.markZoneDirty(corpse.position.zone);
    return ack({ ok: true, self: player });
  });

  socket.on('read_board', ({ boardId }, ack: (r: ReadBoardResponse) => void) => {
    if (!entityId) return ack({ ok: false, reason: 'not_joined' });
    if (typeof boardId !== 'string' || !boardId) return ack({ ok: false, reason: 'bad_args' });
    try {
      const rows = getBoardMessages(boardId);
      const messages = rows.map(r => ({
        id: r.id,
        authorName: r.author_name,
        text: r.text,
        postedAt: r.posted_at,
      }));
      return ack({ ok: true, messages });
    } catch (err) {
      console.error('[read_board]', err);
      return ack({ ok: false, reason: 'server_error' });
    }
  });

  socket.on('post_to_board', ({ boardId, text }, ack: (r: PostBoardResponse) => void) => {
    if (!entityId) return ack({ ok: false, reason: 'not_joined' });
    const player = world.entities.get(entityId);
    if (!player || player.type !== 'player') return ack({ ok: false, reason: 'not_player' });
    if (typeof boardId !== 'string' || !boardId) return ack({ ok: false, reason: 'bad_args' });
    if (typeof text !== 'string') return ack({ ok: false, reason: 'bad_args' });
    const trimmed = text.trim().replace(/\s+/g, ' ');
    if (!trimmed) return ack({ ok: false, reason: 'empty' });
    if (trimmed.length > 200) return ack({ ok: false, reason: 'too_long' });

    // Verify board entity exists and player is in range
    let boardInRange = false;
    for (const e of world.entities.values()) {
      if (e.type !== 'mob') continue;
      if (e.components.ai?.board_id !== boardId) continue;
      if (e.position.zone !== player.position.zone) continue;
      const dist = Math.max(Math.abs(player.position.x - e.position.x), Math.abs(player.position.y - e.position.y));
      if (dist <= 2) { boardInRange = true; break; }
    }
    if (!boardInRange) return ack({ ok: false, reason: 'out_of_range' });

    // Rate limit: one post per minute per player
    const last = boardPostLastAt.get(entityId) ?? 0;
    if (Date.now() - last < BOARD_POST_COOLDOWN_MS) {
      return ack({ ok: false, reason: 'rate_limited' });
    }
    boardPostLastAt.set(entityId, Date.now());

    try {
      postBoardMessage(boardId, player.name, trimmed);
      return ack({ ok: true });
    } catch (err) {
      console.error('[post_to_board]', err);
      return ack({ ok: false, reason: 'server_error' });
    }
  });

  socket.on('disconnect', () => {
    if (!entityId) return;
    const set = socketsByEntity.get(entityId);
    set?.delete(socket.id);
    if (set && set.size === 0) {
      const e = world.entities.get(entityId);
      if (e && e.type === 'player') {
        const meta = playerMeta.get(entityId);
        if (meta) {
          try { upsertCharacter(characterToRow(e, meta.accountId, meta.characterId, meta.slot)); }
          catch (err) { console.error('[disconnect] save failed:', (err as Error).message); }
        }
        world.removeEntity(entityId);
      }
      socketsByEntity.delete(entityId);
      chatTimestamps.delete(entityId);
      playerMeta.delete(entityId);
      if (e) loop.markZoneDirty(e.position.zone);
    }
  });
});

function sanitizeName(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 20);
  return cleaned.length > 0 ? cleaned : null;
}

function characterToRow(
  player: PlayerEntity,
  accountId: string,
  characterId: string,
  slot: number,
): CharacterRow {
  const c = player.components;
  return {
    id:          characterId,
    account_id:  accountId,
    slot:        slot as 1 | 2 | 3,
    is_active:   1,
    name:        player.name  || 'Hero',
    klass:       player.klass || 'fighter',
    color:       player.color || '#6ec6f0',
    zone:        player.position.zone,
    x:           player.position.x,
    y:           player.position.y,
    level:       c.progress?.level          ?? 1,
    xp:          c.progress?.xp             ?? 0,
    max_hp:      c.health?.max              ?? 100,
    strength:    c.stats?.strength          ?? 5,
    dexterity:   c.stats?.dexterity         ?? 5,
    intelligence: c.stats?.intelligence     ?? 5,
    constitution: c.stats?.constitution     ?? 5,
    unspent_points: c.progress?.unspent_points ?? 0,
    gold:        c.wallet?.gold             ?? 0,
    inventory:   c.inventory?.slots         ?? [],
    equipment:   c.equipment               ?? {} as Equipment,
    quests:      c.quests                  ?? { active: [], completed: [] },
  };
}

function broadcastZone(zoneId: string): void {
  const snap = world.snapshotZone(zoneId);
  if (!snap) return;
  io.to(zoneId).emit('zone', snap);
}

httpServer.listen(PORT, () => {
  console.log(`[mmo] listening on http://localhost:${PORT} (autosave every ${AUTOSAVE_INTERVAL_MS}ms)`);
  writeFileSync(join(ROOT, '.game.pid'), String(process.pid));
});
