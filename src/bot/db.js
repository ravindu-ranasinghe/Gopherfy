const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(process.cwd(), 'verified.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS verified_users (
    discord_id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    verified_at INTEGER
  )
`);

const stmtIsVerified = db.prepare('SELECT 1 FROM verified_users WHERE discord_id = ?');
const stmtGetByEmail = db.prepare('SELECT * FROM verified_users WHERE email = ?');
const stmtAddVerified = db.prepare(
  'INSERT OR IGNORE INTO verified_users (discord_id, email, verified_at) VALUES (?, ?, ?)'
);

function isVerified(discordId) {
  return !!stmtIsVerified.get(discordId);
}

function getByEmail(email) {
  return stmtGetByEmail.get(email);
}

function addVerified(discordId, email) {
  return stmtAddVerified.run(discordId, email, Date.now());
}

module.exports = { isVerified, getByEmail, addVerified };
