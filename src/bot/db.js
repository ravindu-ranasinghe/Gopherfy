const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(process.cwd(), 'verified.db'));

db.exec(`
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
`);

const stmtIsVerified = db.prepare('SELECT 1 FROM verified_users WHERE discord_id = ?');
const stmtGetByEmail = db.prepare('SELECT * FROM verified_users WHERE email = ?');
const stmtGetByDiscordId = db.prepare('SELECT * FROM verified_users WHERE discord_id = ?');
const stmtAddVerified = db.prepare(
  'INSERT OR IGNORE INTO verified_users (discord_id, email, verified_at) VALUES (?, ?, ?)'
);
const stmtGetGuildConfig = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?');
const stmtSetGuildConfig = db.prepare(
  'INSERT OR REPLACE INTO guild_config (guild_id, verified_role_id, unverified_role_id, configured_at) VALUES (?, ?, ?, ?)'
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
  isVerified,
  getByEmail,
  getByDiscordId,
  addVerified,
  getGuildConfig,
  setGuildConfig,
};
