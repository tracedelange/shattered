import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.MMO_DB_PATH || join(__dirname, '..', '..', 'data', 'mmo.db');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Additive migrations for installs that pre-date a column.
function addColumnIfMissing(table, name, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
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

export function upsertPlayer({
  id, session_token, name = 'Player', zone, x, y,
  level = 1, xp = 0, max_hp = 100,
  strength = 5, dexterity = 5, intelligence = 5, constitution = 5,
  unspent_points = 0,
  gold = 0, inventory = [], equipment = {},
}) {
  db.prepare(`
    INSERT INTO players
      (id, session_token, name, zone, x, y,
       level, xp, max_hp,
       strength, dexterity, intelligence, constitution,
       unspent_points,
       gold, inventory_json, equipment_json, last_seen)
    VALUES
      (@id, @session_token, @name, @zone, @x, @y,
       @level, @xp, @max_hp,
       @strength, @dexterity, @intelligence, @constitution,
       @unspent_points,
       @gold, @inventory_json, @equipment_json, @last_seen)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
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
    id, session_token, name, zone, x, y,
    level, xp, max_hp,
    strength, dexterity, intelligence, constitution,
    unspent_points,
    gold,
    inventory_json: JSON.stringify(inventory),
    equipment_json: JSON.stringify(equipment),
    last_seen: Date.now(),
  });
}

export function getPlayerBySession(session_token) {
  return db.prepare('SELECT * FROM players WHERE session_token = ?').get(session_token);
}

export function getFlag(key) {
  const row = db.prepare('SELECT value FROM world_flags WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

export function setFlag(key, value) {
  db.prepare(`
    INSERT INTO world_flags (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
}
