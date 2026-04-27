/**
 * createOtpStore() tests against a :memory: SQLite DB with an injected
 * fake clock. Covers code shape, store/validate happy path, expiry,
 * attempt counter, rate-limit window, HMAC determinism + non-leak,
 * length-mismatch wrong-code path, and pruneExpired side effects.
 */
const path = require('path');
const Database = require('better-sqlite3');

const { runMigrations } = require('../../lib/migrations');
const { createOtpStore, generateCode } = require('../otp');

const HMAC_KEY = 'a'.repeat(64);
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'migrations');

function makeStore(overrides = {}) {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  let now = 1_700_000_000_000;
  const clock = jest.fn(() => now);
  const setTime = (t) => {
    now = t;
  };
  const advance = (ms) => {
    now += ms;
  };
  const store = createOtpStore({
    db,
    hmacKey: HMAC_KEY,
    clock,
    ...overrides,
  });
  return { db, store, clock, setTime, advance, now: () => now };
}

describe('generateCode', () => {
  test('returns a 6-digit string in the 100000-999999 range', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toMatch(/^[0-9]{6}$/);
      const n = Number(code);
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThan(1000000);
    }
  });
});

describe('createOtpStore', () => {
  test('refuses too-short hmac keys', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    expect(() => createOtpStore({ db, hmacKey: 'short' })).toThrow(/hmacKey/);
  });

  test('storeOtp + validateOtp happy path returns the email and removes the row', () => {
    const { db, store } = makeStore();
    store.storeOtp('user1', 'alice@umn.edu', '123456');
    const result = store.validateOtp('user1', '123456');
    expect(result).toEqual({ ok: true, email: 'alice@umn.edu' });
    const row = db.prepare('SELECT * FROM otp_pending WHERE discord_id = ?').get('user1');
    expect(row).toBeUndefined();
  });

  test('wrong code increments attempts; 5th wrong returns too_many_attempts and deletes', () => {
    const { db, store } = makeStore();
    store.storeOtp('u', 'e@umn.edu', '111111');
    expect(store.validateOtp('u', '222222').reason).toBe('wrong_code');
    expect(store.validateOtp('u', '222222').reason).toBe('wrong_code');
    expect(store.validateOtp('u', '222222').reason).toBe('wrong_code');
    expect(store.validateOtp('u', '222222').reason).toBe('wrong_code');
    expect(store.validateOtp('u', '222222').reason).toBe('too_many_attempts');
    const row = db.prepare('SELECT 1 FROM otp_pending WHERE discord_id = ?').get('u');
    expect(row).toBeUndefined();
  });

  test('expired pending returns expired and deletes the row', () => {
    const { db, store, advance } = makeStore();
    store.storeOtp('u', 'e@umn.edu', '111111');
    advance(11 * 60 * 1000);
    expect(store.validateOtp('u', '111111').reason).toBe('expired');
    const row = db.prepare('SELECT 1 FROM otp_pending WHERE discord_id = ?').get('u');
    expect(row).toBeUndefined();
  });

  test('no pending returns no_pending without errors', () => {
    const { store } = makeStore();
    expect(store.validateOtp('nobody', '000000').reason).toBe('no_pending');
  });

  test('canSend allows 3 sends in an hour, refuses the 4th', () => {
    const { store } = makeStore();
    const scope = ['user:u'];
    expect(store.canSend(scope).allowed).toBe(true);
    store.commitSend(scope);
    expect(store.canSend(scope).allowed).toBe(true);
    store.commitSend(scope);
    expect(store.canSend(scope).allowed).toBe(true);
    store.commitSend(scope);
    const blocked = store.canSend(scope);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test('canSend resets after the window passes', () => {
    const { store, advance } = makeStore();
    const scope = ['user:u'];
    store.commitSend(scope);
    store.commitSend(scope);
    store.commitSend(scope);
    expect(store.canSend(scope).allowed).toBe(false);
    advance(61 * 60 * 1000);
    expect(store.canSend(scope).allowed).toBe(true);
  });

  test('HMAC determinism: same code + key produce the same hash', () => {
    const { store } = makeStore();
    expect(store.hmacCode('123456')).toBe(store.hmacCode('123456'));
    expect(store.hmacCode('123456')).not.toBe(store.hmacCode('123457'));
  });

  test('storeOtp does not persist plaintext code anywhere', () => {
    const { db, store } = makeStore();
    store.storeOtp('u', 'e@umn.edu', '987654');
    const row = db.prepare('SELECT * FROM otp_pending WHERE discord_id = ?').get('u');
    expect(row.code_hmac).not.toBe('987654');
    expect(row.code_hmac).toMatch(/^[0-9a-f]{64}$/);
    const all = JSON.stringify(row);
    expect(all).not.toContain('987654');
  });

  test('validateOtp with a 5-digit input returns wrong_code without throwing', () => {
    const { store } = makeStore();
    store.storeOtp('u', 'e@umn.edu', '111111');
    expect(() => store.validateOtp('u', '11111')).not.toThrow();
    const result = store.validateOtp('u', '11111');
    expect(result.reason).toBe('wrong_code');
  });

  test('validateOtp with empty string returns wrong_code', () => {
    const { store } = makeStore();
    store.storeOtp('u', 'e@umn.edu', '111111');
    expect(store.validateOtp('u', '').reason).toBe('wrong_code');
  });

  test('pruneExpired removes only expired rows and counters', () => {
    const { db, store, advance } = makeStore();
    store.storeOtp('a', 'a@umn.edu', '111111');
    store.commitSend(['user:a']);
    advance(11 * 60 * 1000);
    store.storeOtp('b', 'b@umn.edu', '222222');
    store.commitSend(['user:b']);

    const result = store.pruneExpired();
    expect(result.pendingRemoved).toBe(1);

    const stillThere = db.prepare('SELECT discord_id FROM otp_pending').all();
    expect(stillThere.map((r) => r.discord_id)).toEqual(['b']);
  });

  test('canSend supports multiple scopes; any blocking scope refuses', () => {
    const { store } = makeStore();
    const scopes = ['user:u', 'email:hash', 'ip:1.2.3.4'];
    store.commitSend(scopes);
    store.commitSend(scopes);
    store.commitSend(scopes);
    const blocked = store.canSend(scopes);
    expect(blocked.allowed).toBe(false);
  });
});
