/**
 * Data-layer tests for /whois: audit insertion, per-guild grouping,
 * and the per-actor 30/hour rate limit. Re-creates the prepared
 * statements + helpers from src/bot/db.js against an in-memory DB so
 * tests don't depend on a file-backed verified.db.
 */
const path = require('path');
const Database = require('better-sqlite3');

const { runMigrations } = require('../../lib/migrations');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'migrations');

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function makeWhoisLayer(db, { now: clockNow = () => Date.now() } = {}) {
  const stmtInsertWhoisAudit = db.prepare(
    'INSERT INTO whois_audit (actor_id, target_id, guild_id, looked_up_at) VALUES (?, ?, ?, ?)',
  );
  const stmtRecentByGuild = db.prepare(
    `SELECT actor_id, COUNT(*) AS lookups, MAX(looked_up_at) AS most_recent
       FROM whois_audit
      WHERE guild_id = ?
      GROUP BY actor_id
      ORDER BY most_recent DESC
      LIMIT ?`,
  );
  const stmtGetCounter = db.prepare('SELECT * FROM otp_send_counter WHERE scope_key = ?');
  const stmtResetCounter = db.prepare(
    `INSERT INTO otp_send_counter (scope_key, count, reset_at)
       VALUES (@scopeKey, 1, @resetAt)
     ON CONFLICT(scope_key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
  );
  const stmtIncrementCounter = db.prepare(
    `INSERT INTO otp_send_counter (scope_key, count, reset_at)
       VALUES (@scopeKey, 1, @resetAt)
     ON CONFLICT(scope_key) DO UPDATE SET count = count + 1`,
  );

  const WINDOW_MS = 60 * 60 * 1000;
  const LIMIT = 30;

  function whoisCanLookup(actorId, { limit = LIMIT } = {}) {
    const now = clockNow();
    const row = stmtGetCounter.get(`whois:${actorId}`);
    if (!row || row.reset_at <= now) return { allowed: true };
    if (row.count >= limit) return { allowed: false, retryAfterMs: row.reset_at - now };
    return { allowed: true };
  }

  function whoisCommitLookup(actorId, { windowMs = WINDOW_MS } = {}) {
    const now = clockNow();
    const scopeKey = `whois:${actorId}`;
    const existing = stmtGetCounter.get(scopeKey);
    if (!existing || existing.reset_at <= now) {
      stmtResetCounter.run({ scopeKey, resetAt: now + windowMs });
    } else {
      stmtIncrementCounter.run({ scopeKey, resetAt: existing.reset_at });
    }
  }

  function insertWhoisAudit(actorId, targetId, guildId) {
    return stmtInsertWhoisAudit.run(actorId, targetId, guildId, clockNow());
  }

  function getRecentWhoisByGuild(guildId, limit = 25) {
    return stmtRecentByGuild.all(guildId, limit);
  }

  return { whoisCanLookup, whoisCommitLookup, insertWhoisAudit, getRecentWhoisByGuild };
}

describe('/whois data layer (audit + rate limit)', () => {
  test('insertWhoisAudit persists a row with the right shape', () => {
    const db = freshDb();
    const layer = makeWhoisLayer(db);
    layer.insertWhoisAudit('mod1', 'target1', 'guild1');
    const rows = db.prepare('SELECT * FROM whois_audit').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: 'mod1',
      target_id: 'target1',
      guild_id: 'guild1',
    });
    expect(typeof rows[0].looked_up_at).toBe('number');
    expect(rows[0].looked_up_at).toBeGreaterThan(0);
  });

  test('getRecentWhoisByGuild groups by actor and sorts by most-recent desc', () => {
    const db = freshDb();
    let now = 1_700_000_000_000;
    const layer = makeWhoisLayer(db, { now: () => now });

    layer.insertWhoisAudit('modA', 't1', 'g1');
    now += 1000;
    layer.insertWhoisAudit('modA', 't2', 'g1');
    now += 1000;
    layer.insertWhoisAudit('modB', 't3', 'g1');
    // a different guild's lookups must not bleed in:
    now += 1000;
    layer.insertWhoisAudit('modA', 't4', 'g2');

    const rows = layer.getRecentWhoisByGuild('g1', 25);
    expect(rows).toHaveLength(2);
    // modB's last lookup is most recent in g1, so it leads.
    expect(rows[0].actor_id).toBe('modB');
    expect(rows[0].lookups).toBe(1);
    expect(rows[1].actor_id).toBe('modA');
    expect(rows[1].lookups).toBe(2);
  });

  test('rate limit allows up to LIMIT lookups, blocks the next, with sane retryAfterMs', () => {
    const db = freshDb();
    let now = 1_700_000_000_000;
    const layer = makeWhoisLayer(db, { now: () => now });

    for (let i = 0; i < 30; i++) {
      const gate = layer.whoisCanLookup('modA');
      expect(gate.allowed).toBe(true);
      layer.whoisCommitLookup('modA');
      now += 100;
    }

    const blocked = layer.whoisCanLookup('modA');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  test('rate limit is per-actor: a different mod is unaffected', () => {
    const db = freshDb();
    const layer = makeWhoisLayer(db);
    for (let i = 0; i < 30; i++) layer.whoisCommitLookup('modA');
    expect(layer.whoisCanLookup('modA').allowed).toBe(false);
    expect(layer.whoisCanLookup('modB').allowed).toBe(true);
  });

  test('window resets when reset_at has passed', () => {
    const db = freshDb();
    let now = 1_700_000_000_000;
    const layer = makeWhoisLayer(db, { now: () => now });
    for (let i = 0; i < 30; i++) layer.whoisCommitLookup('modA');
    expect(layer.whoisCanLookup('modA').allowed).toBe(false);
    now += 60 * 60 * 1000 + 1;
    expect(layer.whoisCanLookup('modA').allowed).toBe(true);
  });
});
