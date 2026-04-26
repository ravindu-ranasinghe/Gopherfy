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

// /whois audit + per-mod rate limit reuse otp_send_counter (the schema is a
// generic scope_key/count/reset_at counter; the OTP service prefixes its
// scopes with user:/email:/ip:, the bot uses whois:<actorId>).
const stmtInsertWhoisAudit = db.prepare(
  'INSERT INTO whois_audit (actor_id, target_id, guild_id, looked_up_at) VALUES (?, ?, ?, ?)',
);
const stmtRecentWhoisByGuild = db.prepare(
  `SELECT actor_id, COUNT(*) AS lookups, MAX(looked_up_at) AS most_recent
     FROM whois_audit
    WHERE guild_id = ?
    GROUP BY actor_id
    ORDER BY most_recent DESC
    LIMIT ?`,
);
const stmtGetWhoisCounter = db.prepare('SELECT * FROM otp_send_counter WHERE scope_key = ?');
const stmtResetWhoisCounter = db.prepare(
  `INSERT INTO otp_send_counter (scope_key, count, reset_at)
     VALUES (@scopeKey, 1, @resetAt)
   ON CONFLICT(scope_key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
);
const stmtIncrementWhoisCounter = db.prepare(
  `INSERT INTO otp_send_counter (scope_key, count, reset_at)
     VALUES (@scopeKey, 1, @resetAt)
   ON CONFLICT(scope_key) DO UPDATE SET count = count + 1`,
);

const stmtInsertDeletionAudit = db.prepare(
  'INSERT INTO deletion_audit (subject_id, reason, deleted_at) VALUES (?, ?, ?)',
);

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

const WHOIS_WINDOW_MS = 60 * 60 * 1000;
const WHOIS_LIMIT = 30;

/**
 * Check whether `actorId` is under the per-hour /whois lookup limit.
 * Returns { allowed: true } or { allowed: false, retryAfterMs }.
 */
function whoisCanLookup(actorId, { now = Date.now(), limit = WHOIS_LIMIT } = {}) {
  const scopeKey = `whois:${actorId}`;
  const row = stmtGetWhoisCounter.get(scopeKey);
  if (!row || row.reset_at <= now) return { allowed: true };
  if (row.count >= limit) {
    return { allowed: false, retryAfterMs: row.reset_at - now };
  }
  return { allowed: true };
}

/**
 * Debit one /whois lookup against `actorId`'s hourly window. The window
 * begins on the first lookup and resets only when reset_at is in the past.
 */
function whoisCommitLookup(actorId, { now = Date.now(), windowMs = WHOIS_WINDOW_MS } = {}) {
  const scopeKey = `whois:${actorId}`;
  const existing = stmtGetWhoisCounter.get(scopeKey);
  if (!existing || existing.reset_at <= now) {
    stmtResetWhoisCounter.run({ scopeKey, resetAt: now + windowMs });
  } else {
    stmtIncrementWhoisCounter.run({ scopeKey, resetAt: existing.reset_at });
  }
}

function insertWhoisAudit(actorId, targetId, guildId, lookedUpAt = Date.now()) {
  return stmtInsertWhoisAudit.run(actorId, targetId, guildId, lookedUpAt);
}

function getRecentWhoisByGuild(guildId, limit = 25) {
  return stmtRecentWhoisByGuild.all(guildId, limit);
}

function insertDeletionAudit(subjectId, reason, deletedAt = Date.now()) {
  return stmtInsertDeletionAudit.run(subjectId, reason, deletedAt);
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
  whoisCanLookup,
  whoisCommitLookup,
  insertWhoisAudit,
  getRecentWhoisByGuild,
  insertDeletionAudit,
};
