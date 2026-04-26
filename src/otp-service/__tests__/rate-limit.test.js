/**
 * Multi-scope rate-limit tests for the OTP store.
 *
 * The store accepts a per-prefix limits map (e.g. { user: 3, email: 3,
 * ip: 30 }). We exercise the three failure axes independently and the
 * realistic abuse scenario where an attacker uses two Discord accounts
 * to drive the same email past its per-hour cap.
 */
const path = require('path');
const Database = require('better-sqlite3');

const { runMigrations } = require('../../lib/migrations');
const { createOtpStore } = require('../otp');

const HMAC_KEY = 'a'.repeat(64);
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'migrations');
const LIMITS = { user: 3, email: 3, ip: 30 };

function makeStore() {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  let now = 1_700_000_000_000;
  const clock = () => now;
  const advance = (ms) => {
    now += ms;
  };
  const store = createOtpStore({ db, hmacKey: HMAC_KEY, clock });
  return { db, store, advance };
}

describe('multi-scope rate limit', () => {
  test('user scope tripped after 3 sends from same Discord ID', () => {
    const { store } = makeStore();
    const scopes = ['user:u1', 'email:e1', 'ip:1.2.3.4'];
    for (let i = 0; i < 3; i++) {
      expect(store.canSend(scopes, { limits: LIMITS }).allowed).toBe(true);
      store.commitSend(scopes);
    }
    const blocked = store.canSend(scopes, { limits: LIMITS });
    expect(blocked.allowed).toBe(false);
    expect(blocked.scope.startsWith('user:')).toBe(true);
  });

  test('email scope tripped after two Discord accounts target the same email', () => {
    const { store } = makeStore();
    const emailScope = 'email:shared';

    // Account 1 sends three times -- legal under each per-axis limit.
    const scopesA = ['user:u1', emailScope, 'ip:ipA'];
    for (let i = 0; i < 3; i++) {
      expect(store.canSend(scopesA, { limits: LIMITS }).allowed).toBe(true);
      store.commitSend(scopesA);
    }

    // Account 2 tries: user:u2 has 0 sends but the shared email scope
    // is at the cap, so the next attempt is blocked.
    const scopesB = ['user:u2', emailScope, 'ip:ipB'];
    const blocked = store.canSend(scopesB, { limits: LIMITS });
    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe(emailScope);
  });

  test('ip scope tripped after 30 sends from same IP across many users/emails', () => {
    const { store } = makeStore();
    for (let i = 0; i < 30; i++) {
      const scopes = [`user:u${i}`, `email:e${i}`, 'ip:1.2.3.4'];
      expect(store.canSend(scopes, { limits: LIMITS }).allowed).toBe(true);
      store.commitSend(scopes);
    }
    const blocked = store.canSend(['user:fresh', 'email:fresh', 'ip:1.2.3.4'], { limits: LIMITS });
    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe('ip:1.2.3.4');
  });

  test('blocked.retryAfterMs reflects the longest remaining window', () => {
    const { store, advance } = makeStore();
    const scopes = ['user:u1', 'email:e1', 'ip:1.2.3.4'];
    // commit 3 sends; record the user reset window
    for (let i = 0; i < 3; i++) {
      store.commitSend(scopes);
    }
    const blocked = store.canSend(scopes, { limits: LIMITS });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60 * 60 * 1000);

    // After the window passes, all three scopes reset.
    advance(60 * 60 * 1000 + 1);
    expect(store.canSend(scopes, { limits: LIMITS }).allowed).toBe(true);
  });

  test('per-scope limits override the default', () => {
    const { store } = makeStore();
    const scopes = ['user:u1'];
    const tightLimits = { user: 1 };
    expect(store.canSend(scopes, { limits: tightLimits }).allowed).toBe(true);
    store.commitSend(scopes);
    expect(store.canSend(scopes, { limits: tightLimits }).allowed).toBe(false);
  });
});
