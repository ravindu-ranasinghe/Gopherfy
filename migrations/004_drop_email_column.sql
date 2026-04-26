-- 004_drop_email_column.sql -- the plaintext `email` column is dropped
-- now that everything reads/writes through `email_hmac`. SQLite cannot
-- DROP COLUMN on a UNIQUE-constrained column directly, so we do the
-- canonical rebuild dance: create the new shape, copy, swap, re-index.
-- This migration runs inside a transaction (see runMigrations).
CREATE TABLE verified_users_new (
  discord_id TEXT PRIMARY KEY,
  verified_at INTEGER,
  email_hmac TEXT
);

INSERT INTO verified_users_new (discord_id, verified_at, email_hmac)
  SELECT discord_id, verified_at, email_hmac FROM verified_users;

DROP TABLE verified_users;
ALTER TABLE verified_users_new RENAME TO verified_users;

CREATE UNIQUE INDEX IF NOT EXISTS idx_verified_users_email_hmac
  ON verified_users(email_hmac);
