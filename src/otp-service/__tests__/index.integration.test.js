/**
 * Integration tests for the OTP service Express app.
 *
 * Each test gets its own :memory: SQLite, its own otpStore, and its
 * own jest.fn() sendEmail. No real Resend, no real Discord, no real
 * port — supertest hands the app object directly.
 *
 * Mirrors the 13 cases (a–m) called out in runbook §Prompt 14.
 */
const path = require('path');
const Database = require('better-sqlite3');
const request = require('supertest');

const { runMigrations } = require('../../lib/migrations');
const { createOtpStore } = require('../otp');
const { createApp } = require('../index');
const { sign } = require('../../lib/http-signing');

const SERVICE_KEY = 'a'.repeat(64);
const HMAC_KEY = 'b'.repeat(64);
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'migrations');

function buildHarness({ now = () => Date.now(), rateLimits } = {}) {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const otpStore = createOtpStore({ db, hmacKey: HMAC_KEY, clock: now });
  const sendEmail = jest.fn().mockResolvedValue({ ok: true });
  const silentLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => silentLog,
  };
  const app = createApp({
    db,
    otpStore,
    sendEmail,
    hmacKey: HMAC_KEY,
    serviceKey: SERVICE_KEY,
    rateLimits,
    log: silentLog,
  });
  return { app, db, otpStore, sendEmail };
}

function signRequest(payload, { secret = SERVICE_KEY, timestamp = Date.now() } = {}) {
  const body = JSON.stringify(payload);
  const signature = sign({ secret, timestamp, body });
  return { body, timestamp, signature };
}

function postSigned(app, route, payload, opts) {
  const { body, timestamp, signature } = signRequest(payload, opts);
  return request(app)
    .post(route)
    .set('Content-Type', 'application/json')
    .set('X-Timestamp', String(timestamp))
    .set('X-Signature', signature)
    .send(body);
}

describe('OTP service /send', () => {
  // (a)
  test('happy path -> 200; sendEmail called once; row + counter present', async () => {
    const h = buildHarness();
    const res = await postSigned(h.app, '/send', { discordId: 'u1', email: 'a@umn.edu' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    const pending = h.db.prepare('SELECT * FROM otp_pending WHERE discord_id = ?').get('u1');
    expect(pending).toBeDefined();
    const counter = h.db
      .prepare('SELECT * FROM otp_send_counter WHERE scope_key = ?')
      .get('user:u1');
    expect(counter.count).toBe(1);
  });

  // (b)
  test('invalid signature -> 401; sendEmail not called', async () => {
    const h = buildHarness();
    const res = await request(h.app)
      .post('/send')
      .set('Content-Type', 'application/json')
      .set('X-Timestamp', String(Date.now()))
      .set('X-Signature', 'deadbeef')
      .send(JSON.stringify({ discordId: 'u1', email: 'a@umn.edu' }));
    expect(res.status).toBe(401);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  // (c)
  test('stale timestamp (>5min) -> 401', async () => {
    const h = buildHarness();
    const stale = Date.now() - 6 * 60 * 1000;
    const res = await postSigned(
      h.app,
      '/send',
      { discordId: 'u1', email: 'a@umn.edu' },
      { timestamp: stale },
    );
    expect(res.status).toBe(401);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  // (d)
  test('malformed body -> 400', async () => {
    const h = buildHarness();
    const res = await postSigned(h.app, '/send', { discordId: 'u1' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, reason: 'bad_request' });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  // (e)
  test('rate-limited 4th send from same user -> 429 rate_limited', async () => {
    const h = buildHarness({ rateLimits: { user: 3, email: 100, ip: 100 } });
    for (let i = 0; i < 3; i++) {
      const ok = await postSigned(h.app, '/send', { discordId: 'u1', email: `e${i}@umn.edu` });
      expect(ok.status).toBe(200);
    }
    const blocked = await postSigned(h.app, '/send', { discordId: 'u1', email: 'final@umn.edu' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ ok: false, reason: 'rate_limited' });
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  // (f)
  test('sendEmail throws -> bot-facing failure; no row; no counter', async () => {
    const h = buildHarness();
    h.sendEmail.mockRejectedValueOnce(new Error('Resend down'));
    const res = await postSigned(h.app, '/send', { discordId: 'u1', email: 'a@umn.edu' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body).toEqual({ ok: false, reason: 'send_failed' });
    const pending = h.db.prepare('SELECT * FROM otp_pending WHERE discord_id = ?').get('u1');
    expect(pending).toBeUndefined();
    const counter = h.db
      .prepare('SELECT * FROM otp_send_counter WHERE scope_key = ?')
      .get('user:u1');
    expect(counter).toBeUndefined();
  });

  // (l)
  test('multi-key rate limit: per-user trips first when same user', async () => {
    const h = buildHarness({ rateLimits: { user: 3, email: 100, ip: 100 } });
    for (let i = 0; i < 3; i++) {
      await postSigned(h.app, '/send', { discordId: 'u1', email: `e${i}@umn.edu` });
    }
    const blocked = await postSigned(h.app, '/send', { discordId: 'u1', email: 'final@umn.edu' });
    expect(blocked.body.reason).toBe('rate_limited');
  });

  // (l, second part)
  test('multi-key rate limit: per-email trips when different users hit one mailbox', async () => {
    const h = buildHarness({ rateLimits: { user: 100, email: 3, ip: 100 } });
    for (let i = 0; i < 3; i++) {
      const ok = await postSigned(h.app, '/send', { discordId: `u${i}`, email: 'shared@umn.edu' });
      expect(ok.status).toBe(200);
    }
    const blocked = await postSigned(h.app, '/send', {
      discordId: 'attacker',
      email: 'shared@umn.edu',
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.reason).toBe('rate_limited');
  });
});

describe('OTP service /verify', () => {
  // (g)
  test('happy path: correct code -> ok:true with email; row deleted', async () => {
    const h = buildHarness();
    h.otpStore.storeOtp('u1', 'a@umn.edu', '123456');
    // forge by reading the actual code: storeOtp persists only the
    // HMAC, so the test has to know the code it just wrote.
    const res = await postSigned(h.app, '/verify', { discordId: 'u1', code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, email: 'a@umn.edu' });
    const pending = h.db.prepare('SELECT * FROM otp_pending WHERE discord_id = ?').get('u1');
    expect(pending).toBeUndefined();
  });

  // (h)
  test('wrong code -> wrong_code; attempts incremented', async () => {
    const h = buildHarness();
    h.otpStore.storeOtp('u1', 'a@umn.edu', '123456');
    const res = await postSigned(h.app, '/verify', { discordId: 'u1', code: '000000' });
    expect(res.body).toEqual({ ok: false, reason: 'wrong_code' });
    const pending = h.db.prepare('SELECT * FROM otp_pending WHERE discord_id = ?').get('u1');
    expect(pending.attempts).toBe(1);
  });

  // (i)
  test('5 wrong codes -> too_many_attempts on the 5th; row deleted', async () => {
    const h = buildHarness();
    h.otpStore.storeOtp('u1', 'a@umn.edu', '123456');
    for (let i = 0; i < 4; i++) {
      const r = await postSigned(h.app, '/verify', { discordId: 'u1', code: '000000' });
      expect(r.body.reason).toBe('wrong_code');
    }
    const fifth = await postSigned(h.app, '/verify', { discordId: 'u1', code: '000000' });
    expect(fifth.body).toEqual({ ok: false, reason: 'too_many_attempts' });
    const pending = h.db.prepare('SELECT * FROM otp_pending WHERE discord_id = ?').get('u1');
    expect(pending).toBeUndefined();
  });

  // (j)
  test('expired code -> expired; row deleted', async () => {
    let now = 1_700_000_000_000;
    const h = buildHarness({ now: () => now });
    h.otpStore.storeOtp('u1', 'a@umn.edu', '123456');
    now += 11 * 60 * 1000; // > 10 min TTL
    const res = await postSigned(h.app, '/verify', { discordId: 'u1', code: '123456' });
    expect(res.body).toEqual({ ok: false, reason: 'expired' });
    const pending = h.db.prepare('SELECT * FROM otp_pending WHERE discord_id = ?').get('u1');
    expect(pending).toBeUndefined();
  });

  // (k)
  test('no pending row -> no_pending', async () => {
    const h = buildHarness();
    const res = await postSigned(h.app, '/verify', { discordId: 'nobody', code: '123456' });
    expect(res.body).toEqual({ ok: false, reason: 'no_pending' });
  });
});

describe('OTP service response hygiene', () => {
  // (m)
  test('regression: the OTP code never appears in any /send response', async () => {
    const h = buildHarness();
    let capturedCode;
    h.sendEmail.mockImplementation(async (_email, code) => {
      capturedCode = code;
    });
    const res = await postSigned(h.app, '/send', { discordId: 'u1', email: 'a@umn.edu' });
    expect(capturedCode).toMatch(/^\d{6}$/);
    expect(JSON.stringify(res.body)).not.toContain(capturedCode);
    expect(JSON.stringify(res.headers)).not.toContain(capturedCode);
  });

  // (m, second part: also true on /verify wrong_code)
  test('regression: the OTP code never appears in /verify response on wrong_code', async () => {
    const h = buildHarness();
    h.otpStore.storeOtp('u1', 'a@umn.edu', '123456');
    const res = await postSigned(h.app, '/verify', { discordId: 'u1', code: '000000' });
    expect(JSON.stringify(res.body)).not.toContain('123456');
    expect(JSON.stringify(res.body)).not.toContain('000000');
  });
});
