import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClassId, Equipment, InventoryStack } from '../../shared/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.MMO_DB_PATH || join(__dirname, '..', '..', 'data', 'mmo.db');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

function addColumnIfMissing(table: string, name: string, def: string): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
addColumnIfMissing('players', 'name',           "TEXT NOT NULL DEFAULT 'Player'");
addColumnIfMissing('players', 'level',          'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('players', 'xp',             'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('players', 'max_hp',         'INTEGER NOT NULL DEFAULT 100');
addColumnIfMissing('players', 'strength',       'INTEGER NOT NULL DEFAULT 5');
addColumnIfMissing('players', 'unspent_points', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('players', 'gold',           'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('players', 'inventory_json', "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing('players', 'equipment_json', "TEXT NOT NULL DEFAULT '{}'");
addColumnIfMissing('players', 'dexterity',      'INTEGER NOT NULL DEFAULT 5');
addColumnIfMissing('players', 'intelligence',   'INTEGER NOT NULL DEFAULT 5');
addColumnIfMissing('players', 'constitution',   'INTEGER NOT NULL DEFAULT 5');
addColumnIfMissing('players', 'klass',          "TEXT NOT NULL DEFAULT 'fighter'");

export interface PlayerRow {
  id: string;
  session_token: string;
  name?: string;
  klass?: ClassId;
  zone: string;
  x: number;
  y: number;
  level?: number;
  xp?: number;
  max_hp?: number;
  strength?: number;
  dexterity?: number;
  intelligence?: number;
  constitution?: number;
  unspent_points?: number;
  gold?: number;
  inventory?: (InventoryStack | null)[];
  equipment?: Equipment | Record<string, InventoryStack | null>;
}

export function upsertPlayer({
  id, session_token, name = 'Player', klass = 'fighter' as ClassId, zone, x, y,
  level = 1, xp = 0, max_hp = 100,
  strength = 5, dexterity = 5, intelligence = 5, constitution = 5,
  unspent_points = 0,
  gold = 0, inventory = [], equipment = {},
}: PlayerRow): void {
  db.prepare(`
    INSERT INTO players
      (id, session_token, name, klass, zone, x, y,
       level, xp, max_hp,
       strength, dexterity, intelligence, constitution,
       unspent_points,
       gold, inventory_json, equipment_json, last_seen)
    VALUES
      (@id, @session_token, @name, @klass, @zone, @x, @y,
       @level, @xp, @max_hp,
       @strength, @dexterity, @intelligence, @constitution,
       @unspent_points,
       @gold, @inventory_json, @equipment_json, @last_seen)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      klass = excluded.klass,
      zone = excluded.zone,
      x = excluded.x,
      y = excluded.y,
      level = excluded.level,
      xp = excluded.xp,
      max_hp = excluded.max_hp,
      strength = excluded.strength,
      dexterity = excluded.dexterity,
      intelligence = excluded.intelligence,
      constitution = excluded.constitution,
      unspent_points = excluded.unspent_points,
      gold = excluded.gold,
      inventory_json = excluded.inventory_json,
      equipment_json = excluded.equipment_json,
      last_seen = excluded.last_seen
  `).run({
    id, session_token, name, klass, zone, x, y,
    level, xp, max_hp,
    strength, dexterity, intelligence, constitution,
    unspent_points,
    gold,
    inventory_json: JSON.stringify(inventory),
    equipment_json: JSON.stringify(equipment),
    last_seen: Date.now(),
  });
}

export interface StoredPlayerRow {
  id: string; session_token: string; name: string; klass: ClassId;
  zone: string; x: number; y: number;
  level: number; xp: number; max_hp: number;
  strength: number; dexterity: number; intelligence: number; constitution: number;
  unspent_points: number; gold: number;
  inventory_json: string; equipment_json: string;
  last_seen: number;
}

export function getPlayerBySession(session_token: string): StoredPlayerRow | undefined {
  return db.prepare('SELECT * FROM players WHERE session_token = ?').get(session_token) as StoredPlayerRow | undefined;
}

export function getFlag(key: string): unknown {
  const row = db.prepare('SELECT value FROM world_flags WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

export function setFlag(key: string, value: unknown): void {
  db.prepare(`
    INSERT INTO world_flags (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
}
