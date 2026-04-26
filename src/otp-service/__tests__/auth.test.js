/**
 * OTP service signature middleware integration tests.
 *
 * The full createApp factory lands in Prompt 14. For now, build a tiny
 * Express app inline that mirrors index.js's middleware stack
 * (express.json with rawBody capture + signature gate) and exercises
 * the four failure modes runbook §Prompt 7 calls out: missing header,
 * tampered body, drifted timestamp, wrong secret -- plus the happy
 * path.
 */
const express = require('express');
const request = require('supertest');

const { sign, verify } = require('../../lib/http-signing');

const SECRET = 'a'.repeat(64);

function buildApp(secret = SECRET) {
  const app = express();
  app.use(
    express.json({
      limit: '1kb',
      verify: (req, _res, buf) => {
        req.rawBody = buf.length ? buf.toString('utf8') : '';
      },
    }),
  );
  app.use((req, res, next) => {
    const timestamp = req.get('x-timestamp');
    const signature = req.get('x-signature');
    if (!timestamp || !signature) {
      return res.status(401).json({ ok: false, reason: 'unauthorized' });
    }
    const ok = verify({
      secret,
      timestamp,
      body: req.rawBody ?? '',
      signature,
    });
    if (!ok) return res.status(401).json({ ok: false, reason: 'unauthorized' });
    next();
  });
  app.post('/echo', (req, res) => res.json({ ok: true, body: req.body }));
  return app;
}

function signed(payload) {
  const body = JSON.stringify(payload);
  const ts = Date.now();
  const sig = sign({ secret: SECRET, timestamp: ts, body });
  return { body, ts, sig };
}

describe('OTP service signature middleware', () => {
  test('valid signature -> 200', async () => {
    const app = buildApp();
    const { body, ts, sig } = signed({ x: 1 });
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .set('X-Timestamp', String(ts))
      .set('X-Signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, body: { x: 1 } });
  });

  test('missing signature header -> 401', async () => {
    const app = buildApp();
    const { body, ts } = signed({ x: 1 });
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .set('X-Timestamp', String(ts))
      .send(body);
    expect(res.status).toBe(401);
  });

  test('missing timestamp header -> 401', async () => {
    const app = buildApp();
    const { body, sig } = signed({ x: 1 });
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(body);
    expect(res.status).toBe(401);
  });

  test('tampered body -> 401', async () => {
    const app = buildApp();
    const { ts, sig } = signed({ x: 1 });
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .set('X-Timestamp', String(ts))
      .set('X-Signature', sig)
      .send(JSON.stringify({ x: 2 }));
    expect(res.status).toBe(401);
  });

  test('legacy bearer token -> 401', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${SECRET}`)
      .send(JSON.stringify({ x: 1 }));
    expect(res.status).toBe(401);
  });

  test('signed with wrong secret -> 401', async () => {
    const app = buildApp();
    const body = JSON.stringify({ x: 1 });
    const ts = Date.now();
    const sig = sign({ secret: 'b'.repeat(64), timestamp: ts, body });
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .set('X-Timestamp', String(ts))
      .set('X-Signature', sig)
      .send(body);
    expect(res.status).toBe(401);
  });

  test('stale timestamp (>5 min) -> 401', async () => {
    const app = buildApp();
    const body = JSON.stringify({ x: 1 });
    const ts = Date.now() - 6 * 60 * 1000;
    const sig = sign({ secret: SECRET, timestamp: ts, body });
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .set('X-Timestamp', String(ts))
      .set('X-Signature', sig)
      .send(body);
    expect(res.status).toBe(401);
  });
});
