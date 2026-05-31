CREATE TABLE IF NOT EXISTS players (
  id              TEXT PRIMARY KEY,
  session_token   TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL DEFAULT 'Player',
  zone            TEXT NOT NULL,
  x               INTEGER NOT NULL,
  y               INTEGER NOT NULL,
  level           INTEGER NOT NULL DEFAULT 1,
  xp              INTEGER NOT NULL DEFAULT 0,
  max_hp          INTEGER NOT NULL DEFAULT 100,
  strength        INTEGER NOT NULL DEFAULT 5,
  unspent_points  INTEGER NOT NULL DEFAULT 0,
  last_seen       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_state (
  id         TEXT PRIMARY KEY,
  zone       TEXT NOT NULL,
  type       TEXT NOT NULL,
  components TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_flags (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
