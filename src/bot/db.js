const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations } = require('../lib/migrations');
const { backfillEmailHmac, emailHmac } = require('../lib/backfill-email-hmac');
const log = require('../lib/logger').child({ module: 'db' });

const HMAC_KEY = process.env.OTP_HMAC_KEY;
if (!HMAC_KEY || HMAC_KEY.length < 32) {
  log.error('OTP_HMAC_KEY missing or too short (need >=32 chars). Refusing to start.');
  process.exit(1);
}

const dbPath = path.join(process.cwd(), 'verified.db');
const db = new Database(dbPath);

// Pragmas must run before migrations so the schema is created against the
// final journal mode and constraint behavior.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const journalMode = db.pragma('journal_mode', { simple: true });
log.info({ journalMode, dbPath }, 'database opened');

const migrationsDir = path.join(__dirname, '..', '..', 'migrations');
runMigrations(db, migrationsDir, log);

// Backfill any pre-migration rows so getByEmailHmac works against the
// existing user base. After 004 drops the email column this is a no-op.
backfillEmailHmac({ db, hmacKey: HMAC_KEY, log });

const stmtIsVerified = db.prepare('SELECT 1 FROM verified_users WHERE discord_id = ?');
const stmtGetByEmailHmac = db.prepare('SELECT * FROM verified_users WHERE email_hmac = ?');
const stmtGetByDiscordId = db.prepare('SELECT * FROM verified_users WHERE discord_id = ?');
const stmtAddVerifiedHmac = db.prepare(
  'INSERT OR IGNORE INTO verified_users (discord_id, email_hmac, verified_at) VALUES (?, ?, ?)',
);
const stmtDeleteVerified = db.prepare('DELETE FROM verified_users WHERE discord_id = ?');
const stmtGetGuildConfig = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?');
const stmtSetGuildConfig = db.prepare(
  'INSERT OR REPLACE INTO guild_config (guild_id, verified_role_id, unverified_role_id, configured_at) VALUES (?, ?, ?, ?)',
);
const stmtDeleteGuildConfig = db.prepare('DELETE FROM guild_config WHERE guild_id = ?');

function isVerified(discordId) {
  return !!stmtIsVerified.get(discordId);
}

function getByEmailHmac(emailHmacHex) {
  return stmtGetByEmailHmac.get(emailHmacHex);
}

function getByDiscordId(discordId) {
  return stmtGetByDiscordId.get(discordId);
}

function addVerifiedHmac(discordId, emailHmacHex) {
  return stmtAddVerifiedHmac.run(discordId, emailHmacHex, Date.now());
}

function deleteVerified(discordId) {
  return stmtDeleteVerified.run(discordId);
}

function getGuildConfig(guildId) {
  return stmtGetGuildConfig.get(guildId);
}

function setGuildConfig(guildId, verifiedRoleId, unverifiedRoleId) {
  return stmtSetGuildConfig.run(guildId, verifiedRoleId, unverifiedRoleId, Date.now());
}

function deleteGuildConfig(guildId) {
  return stmtDeleteGuildConfig.run(guildId);
}

function hashEmail(email) {
  return emailHmac(HMAC_KEY, email);
}

module.exports = {
  db,
  isVerified,
  getByEmailHmac,
  getByDiscordId,
  addVerifiedHmac,
  deleteVerified,
  getGuildConfig,
  setGuildConfig,
  deleteGuildConfig,
  hashEmail,
};
