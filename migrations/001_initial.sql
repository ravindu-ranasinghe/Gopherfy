-- 001_initial.sql -- ported verbatim from the original src/bot/db.js
-- inline schema. Both tables existed before the migration system did, so
-- IF NOT EXISTS makes this safe to apply against any pre-existing
-- database.
CREATE TABLE IF NOT EXISTS verified_users (
  discord_id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  verified_at INTEGER
);

CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  verified_role_id TEXT NOT NULL,
  unverified_role_id TEXT NOT NULL,
  configured_at INTEGER
);
