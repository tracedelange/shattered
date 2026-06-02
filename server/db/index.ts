import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClassId, Equipment, InventoryStack, QuestsComponent } from '../../shared/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.MMO_DB_PATH || join(__dirname, '..', '..', 'data', 'mmo.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));

/** Closes the underlying SQLite connection. Call once at shutdown. */
export function closeDb(): void { db.close(); }

// ---------------------------------------------------------------------------
// Accounts  (one row per Firebase UID)
// ---------------------------------------------------------------------------

export interface AccountRow {
  firebase_uid: string;
  email: string | null;
  created_at: number;
}

const upsertAccountStmt = db.prepare(`
  INSERT INTO accounts (firebase_uid, email, created_at)
  VALUES (@firebase_uid, @email, @created_at)
  ON CONFLICT(firebase_uid) DO UPDATE SET email = excluded.email
`);

export function upsertAccount({ firebase_uid, email }: { firebase_uid: string; email: string | null }): void {
  upsertAccountStmt.run({ firebase_uid, email, created_at: Date.now() });
}

export function getAccountByUid(firebase_uid: string): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE firebase_uid = ?').get(firebase_uid) as AccountRow | undefined;
}

// ---------------------------------------------------------------------------
// Characters  (up to 3 per account)
// ---------------------------------------------------------------------------

export interface CharacterRow {
  id: string;
  account_id: string;
  slot: 1 | 2 | 3;
  is_active?: 0 | 1;
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
  quests?: QuestsComponent;
}

export interface StoredCharacterRow {
  id: string;
  account_id: string;
  slot: number;
  is_active: number;
  name: string;
  klass: ClassId;
  zone: string;
  x: number;
  y: number;
  level: number;
  xp: number;
  max_hp: number;
  strength: number;
  dexterity: number;
  intelligence: number;
  constitution: number;
  unspent_points: number;
  gold: number;
  inventory_json: string;
  equipment_json: string;
  quests_json: string;
  last_seen: number;
}

const upsertCharacterStmt = db.prepare(`
  INSERT INTO characters
    (id, account_id, slot, is_active, name, klass, zone, x, y,
     level, xp, max_hp,
     strength, dexterity, intelligence, constitution,
     unspent_points,
     gold, inventory_json, equipment_json, quests_json, last_seen)
  VALUES
    (@id, @account_id, @slot, @is_active, @name, @klass, @zone, @x, @y,
     @level, @xp, @max_hp,
     @strength, @dexterity, @intelligence, @constitution,
     @unspent_points,
     @gold, @inventory_json, @equipment_json, @quests_json, @last_seen)
  ON CONFLICT(id) DO UPDATE SET
    is_active       = excluded.is_active,
    name            = excluded.name,
    klass           = excluded.klass,
    zone            = excluded.zone,
    x               = excluded.x,
    y               = excluded.y,
    level           = excluded.level,
    xp              = excluded.xp,
    max_hp          = excluded.max_hp,
    strength        = excluded.strength,
    dexterity       = excluded.dexterity,
    intelligence    = excluded.intelligence,
    constitution    = excluded.constitution,
    unspent_points  = excluded.unspent_points,
    gold            = excluded.gold,
    inventory_json  = excluded.inventory_json,
    equipment_json  = excluded.equipment_json,
    quests_json     = excluded.quests_json,
    last_seen       = excluded.last_seen
`);

function rowParams(row: CharacterRow) {
  return {
    id:             row.id,
    account_id:     row.account_id,
    slot:           row.slot,
    is_active:      row.is_active      ?? 0,
    name:           row.name           ?? 'Hero',
    klass:          row.klass          ?? 'fighter',
    zone:           row.zone,
    x:              row.x,
    y:              row.y,
    level:          row.level          ?? 1,
    xp:             row.xp             ?? 0,
    max_hp:         row.max_hp         ?? 100,
    strength:       row.strength       ?? 5,
    dexterity:      row.dexterity      ?? 5,
    intelligence:   row.intelligence   ?? 5,
    constitution:   row.constitution   ?? 5,
    unspent_points: row.unspent_points ?? 0,
    gold:           row.gold           ?? 0,
    inventory_json: JSON.stringify(row.inventory ?? []),
    equipment_json: JSON.stringify(row.equipment ?? {}),
    quests_json:    JSON.stringify(row.quests    ?? { active: [], completed: [] }),
    last_seen:      Date.now(),
  };
}

export function upsertCharacter(row: CharacterRow): void {
  upsertCharacterStmt.run(rowParams(row));
}

/** Batch upsert wrapped in a single transaction. */
export const saveCharacters = db.transaction((rows: CharacterRow[]): void => {
  for (const row of rows) upsertCharacterStmt.run(rowParams(row));
});

export function getCharacterById(id: string): StoredCharacterRow | undefined {
  return db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as StoredCharacterRow | undefined;
}

export function getCharactersByAccount(account_id: string): StoredCharacterRow[] {
  return db.prepare('SELECT * FROM characters WHERE account_id = ? ORDER BY slot').all(account_id) as StoredCharacterRow[];
}

export function getActiveCharacter(account_id: string): StoredCharacterRow | undefined {
  return db.prepare('SELECT * FROM characters WHERE account_id = ? AND is_active = 1').get(account_id) as StoredCharacterRow | undefined;
}

/** Sets the given character as active and deactivates all others on the account. */
export const setActiveCharacter = db.transaction((account_id: string, character_id: string): void => {
  db.prepare('UPDATE characters SET is_active = 0 WHERE account_id = ?').run(account_id);
  db.prepare('UPDATE characters SET is_active = 1 WHERE id = ? AND account_id = ?').run(character_id, account_id);
});

export function countCharacters(account_id: string): number {
  const row = db.prepare('SELECT COUNT(*) as n FROM characters WHERE account_id = ?').get(account_id) as { n: number };
  return row.n;
}

export function deleteCharacter(id: string, account_id: string): void {
  db.prepare('DELETE FROM characters WHERE id = ? AND account_id = ?').run(id, account_id);
}
