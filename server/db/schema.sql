-- One-time cleanup of tables from earlier iterations.
DROP TABLE IF EXISTS players;
DROP TABLE IF EXISTS entity_state;
DROP TABLE IF EXISTS world_flags;

-- One row per Firebase account.
CREATE TABLE IF NOT EXISTS accounts (
  firebase_uid  TEXT PRIMARY KEY,
  email         TEXT,
  created_at    INTEGER NOT NULL
);

-- Up to 3 characters per account. Slot is 1, 2, or 3 and unique within an
-- account. Only one character per account may have is_active = 1 (enforced in
-- application code via setActiveCharacter).
CREATE TABLE IF NOT EXISTS characters (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(firebase_uid),
  slot            INTEGER NOT NULL CHECK(slot IN (1,2,3)),
  is_active       INTEGER NOT NULL DEFAULT 0,
  name            TEXT NOT NULL DEFAULT 'Hero',
  klass           TEXT NOT NULL DEFAULT 'fighter',
  zone            TEXT NOT NULL,
  x               INTEGER NOT NULL,
  y               INTEGER NOT NULL,
  level           INTEGER NOT NULL DEFAULT 1,
  xp              INTEGER NOT NULL DEFAULT 0,
  max_hp          INTEGER NOT NULL DEFAULT 100,
  strength        INTEGER NOT NULL DEFAULT 5,
  dexterity       INTEGER NOT NULL DEFAULT 5,
  intelligence    INTEGER NOT NULL DEFAULT 5,
  constitution    INTEGER NOT NULL DEFAULT 5,
  unspent_points  INTEGER NOT NULL DEFAULT 0,
  gold            INTEGER NOT NULL DEFAULT 0,
  color           TEXT NOT NULL DEFAULT '#6ec6f0',
  inventory_json  TEXT NOT NULL DEFAULT '[]',
  equipment_json  TEXT NOT NULL DEFAULT '{}',
  quests_json     TEXT NOT NULL DEFAULT '{"active":[],"completed":[]}',
  last_seen       INTEGER NOT NULL,
  UNIQUE(account_id, slot)
);
