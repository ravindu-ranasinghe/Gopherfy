/**
 * email_hmac tests using a :memory: DB and the migrations/ directory.
 *
 * The bot's db.js is too eager to import directly (it opens
 * verified.db on cwd), so we replicate its prepared-statement pattern
 * here and exercise the same SQL the bot relies on.
 */
const path = require('path');
const Database = require('better-sqlite3');

const { runMigrations } = require('../../lib/migrations');
const { backfillEmailHmac, emailHmac } = require('../../lib/backfill-email-hmac');

const HMAC_KEY = 'a'.repeat(64);
const ALT_KEY = 'b'.repeat(64);
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'migrations');

function freshDb({ stopAtVersion } = {}) {
  const db = new Database(':memory:');
  if (stopAtVersion === 1) {
    // apply only 001 manually so we can introduce dummy rows with the
    // plaintext email column intact (matches a "pre-002" pristine DB).
    db.exec(`CREATE TABLE IF NOT EXISTS verified_users (
      discord_id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      verified_at INTEGER
    );`);
    db.pragma('user_version = 1');
    return db;
  }
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

describe('email_hmac round trip', () => {
  test('addVerifiedHmac + getByEmailHmac matches', () => {
    const db = freshDb();
    const insert = db.prepare(
      'INSERT INTO verified_users (discord_id, email_hmac, verified_at) VALUES (?, ?, ?)',
    );
    const select = db.prepare('SELECT * FROM verified_users WHERE email_hmac = ?');

    const hash = emailHmac(HMAC_KEY, 'alice@umn.edu');
    insert.run('user1', hash, Date.now());
    const row = select.get(hash);
    expect(row).toBeDefined();
    expect(row.discord_id).toBe('user1');
    expect(row.email_hmac).toBe(hash);
  });

  test('different keys produce different hashes (regression: key swap)', () => {
    const db = freshDb();
    const insert = db.prepare(
      'INSERT INTO verified_users (discord_id, email_hmac, verified_at) VALUES (?, ?, ?)',
    );
    const select = db.prepare('SELECT * FROM verified_users WHERE email_hmac = ?');

    insert.run('user1', emailHmac(HMAC_KEY, 'alice@umn.edu'), Date.now());
    const lookupWithWrongKey = select.get(emailHmac(ALT_KEY, 'alice@umn.edu'));
    expect(lookupWithWrongKey).toBeUndefined();
  });
});

describe('backfillEmailHmac (legacy DB)', () => {
  test('backfills NULL email_hmac rows from existing email column', () => {
    const db = new Database(':memory:');
    // simulate state immediately after migration 003: email + email_hmac
    // both present, email_hmac NULL for legacy rows.
    db.exec(`CREATE TABLE verified_users (
      discord_id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      verified_at INTEGER,
      email_hmac TEXT
    );`);
    db.pragma('user_version = 3');
    const insert = db.prepare(
      'INSERT INTO verified_users (discord_id, email, verified_at) VALUES (?, ?, ?)',
    );
    insert.run('u1', 'alice@umn.edu', Date.now());
    insert.run('u2', 'bob@umn.edu', Date.now());

    const result = backfillEmailHmac({ db, hmacKey: HMAC_KEY });
    expect(result.backfilled).toBe(2);
    expect(result.skipped).toBe(0);

    const a = db.prepare('SELECT email_hmac FROM verified_users WHERE discord_id = ?').get('u1');
    expect(a.email_hmac).toBe(emailHmac(HMAC_KEY, 'alice@umn.edu'));
  });

  test('skips rows that already have email_hmac', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE verified_users (
      discord_id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      verified_at INTEGER,
      email_hmac TEXT
    );`);
    const insert = db.prepare(
      'INSERT INTO verified_users (discord_id, email, verified_at, email_hmac) VALUES (?, ?, ?, ?)',
    );
    insert.run('u1', 'alice@umn.edu', Date.now(), 'preset_hmac');
    const result = backfillEmailHmac({ db, hmacKey: HMAC_KEY });
    expect(result.backfilled).toBe(0);
    expect(result.skipped).toBe(1);
    const a = db.prepare('SELECT email_hmac FROM verified_users WHERE discord_id = ?').get('u1');
    expect(a.email_hmac).toBe('preset_hmac');
  });

  test('returns no-op when email column is gone (post 004)', () => {
    const db = freshDb();
    const result = backfillEmailHmac({ db, hmacKey: HMAC_KEY });
    expect(result.backfilled).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

describe('verified_users schema after all migrations', () => {
  test('email_hmac present; email restored by migration 007', () => {
    const db = freshDb();
    const cols = db
      .prepare("PRAGMA table_info('verified_users')")
      .all()
      .map((c) => c.name);
    expect(cols).toContain('email_hmac');
    expect(cols).toContain('email');
  });
});
