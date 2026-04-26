const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations } = require('../lib/migrations');
const log = require('../lib/logger').child({ module: 'db' });

const dbPath = path.join(process.cwd(), 'verified.db');
const db = new Database(dbPath);

// Pragmas must run before migrations so the schema is created against the
// final journal mode and constraint behavior.
// - WAL increases write throughput and read concurrency.
// - synchronous=NORMAL is the safe-and-fast pairing for WAL mode.
// - foreign_keys=ON is required for FK constraints to actually fire
//   (SQLite default is off).
// - busy_timeout makes contended writes wait briefly instead of failing
//   immediately with SQLITE_BUSY.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const journalMode = db.pragma('journal_mode', { simple: true });
log.info({ journalMode, dbPath }, 'database opened');

const migrationsDir = path.join(__dirname, '..', '..', 'migrations');
runMigrations(db, migrationsDir, log);

const stmtIsVerified = db.prepare('SELECT 1 FROM verified_users WHERE discord_id = ?');
const stmtGetByEmail = db.prepare('SELECT * FROM verified_users WHERE email = ?');
const stmtGetByDiscordId = db.prepare('SELECT * FROM verified_users WHERE discord_id = ?');
const stmtAddVerified = db.prepare(
  'INSERT OR IGNORE INTO verified_users (discord_id, email, verified_at) VALUES (?, ?, ?)',
);
const stmtGetGuildConfig = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?');
const stmtSetGuildConfig = db.prepare(
  'INSERT OR REPLACE INTO guild_config (guild_id, verified_role_id, unverified_role_id, configured_at) VALUES (?, ?, ?, ?)',
);

function isVerified(discordId) {
  return !!stmtIsVerified.get(discordId);
}

function getByEmail(email) {
  return stmtGetByEmail.get(email);
}

function getByDiscordId(discordId) {
  return stmtGetByDiscordId.get(discordId);
}

function addVerified(discordId, email) {
  return stmtAddVerified.run(discordId, email, Date.now());
}

function getGuildConfig(guildId) {
  return stmtGetGuildConfig.get(guildId);
}

function setGuildConfig(guildId, verifiedRoleId, unverifiedRoleId) {
  return stmtSetGuildConfig.run(guildId, verifiedRoleId, unverifiedRoleId, Date.now());
}

module.exports = {
  db,
  isVerified,
  getByEmail,
  getByDiscordId,
  addVerified,
  getGuildConfig,
  setGuildConfig,
};
