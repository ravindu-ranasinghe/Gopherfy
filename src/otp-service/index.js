require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { runMigrations } = require('../lib/migrations');
const { createOtpStore } = require('./otp');
const { sendOtp } = require('./email');
const { verify: verifySignature } = require('../lib/http-signing');
const log = require('../lib/logger').child({ module: 'otp-service' });

const port = process.env.OTP_SERVICE_PORT || 3001;
const serviceKey = process.env.OTP_SERVICE_KEY;
const hmacKey = process.env.OTP_HMAC_KEY;

if (!serviceKey || serviceKey.length < 32) {
  log.error('OTP_SERVICE_KEY missing or too short (need >=32 chars). Refusing to start.');
  process.exit(1);
}
if (!hmacKey || hmacKey.length < 32) {
  log.error('OTP_HMAC_KEY missing or too short (need >=32 chars). Refusing to start.');
  process.exit(1);
}

// The OTP service shares the bot's verified.db file but opens its own
// connection. SQLite WAL mode supports concurrent readers + a single
// writer across processes; busy_timeout absorbs short contention.
const dbPath = path.join(process.cwd(), 'verified.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
runMigrations(db, path.join(__dirname, '..', '..', 'migrations'), log);

const otpStore = createOtpStore({ db, hmacKey });

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    log.warn({ name, raw }, 'invalid numeric env var, using fallback');
    return fallback;
  }
  return n;
}

const RATE_LIMITS = {
  user: intFromEnv('OTP_RATE_USER_PER_HOUR', 3),
  email: intFromEnv('OTP_RATE_EMAIL_PER_HOUR', 3),
  ip: intFromEnv('OTP_RATE_IP_PER_HOUR', 30),
};

function emailHmac(email) {
  return crypto.createHmac('sha256', hmacKey).update(email).digest('hex');
}

const app = express();
// Capture req.rawBody so the signature verifier sees the EXACT bytes the
// client signed. A re-stringified req.body could differ in whitespace.
app.use(
  express.json({
    limit: '1kb',
    verify: (req, _res, buf) => {
      req.rawBody = buf.length ? buf.toString('utf8') : '';
    },
  }),
);

app.use((req, res, next) => {
  res.on('finish', () => {
    log.info({ method: req.method, path: req.path, status: res.statusCode }, 'request');
  });
  next();
});

function isNonEmptyString(v, maxLen) {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

app.use((req, res, next) => {
  const timestamp = req.get('x-timestamp');
  const signature = req.get('x-signature');
  if (!timestamp || !signature) {
    log.warn({ reason: 'missing_headers', path: req.path }, 'request rejected');
    return res.status(401).json({ ok: false, reason: 'unauthorized' });
  }
  const ok = verifySignature({
    secret: serviceKey,
    timestamp,
    body: req.rawBody ?? '',
    signature,
  });
  if (!ok) {
    log.warn({ reason: 'bad_signature_or_stale', path: req.path }, 'request rejected');
    return res.status(401).json({ ok: false, reason: 'unauthorized' });
  }
  next();
});

app.post('/send', async (req, res) => {
  const { discordId, email } = req.body ?? {};

  if (!isNonEmptyString(discordId, 64) || !isNonEmptyString(email, 320)) {
    return res.status(400).json({ ok: false, reason: 'bad_request' });
  }

  // Three-axis rate limit: per-user, per-email-HMAC, per-IP. The
  // per-email key prevents an attacker rotating Discord accounts to
  // spam a single mailbox. The per-IP key catches a flood from one
  // host across many emails. canSend([...]) returns the scope with
  // the longest remaining window so Retry-After is correct.
  const scopes = [`user:${discordId}`, `email:${emailHmac(email)}`, `ip:${req.ip}`];
  const gate = otpStore.canSend(scopes, { limits: RATE_LIMITS });
  if (!gate.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil(gate.retryAfterMs / 1000));
    res.set('Retry-After', String(retryAfterSec));
    log.warn({ scope: gate.scope, retryAfterSec }, 'rate limited');
    return res.json({ ok: false, reason: 'rate_limited' });
  }

  const code = otpStore.generateCode();

  try {
    await sendOtp(email, code);
  } catch (err) {
    log.error({ err }, 'sendOtp failed');
    return res.json({ ok: false, reason: 'send_failed' });
  }

  otpStore.storeOtp(discordId, email, code);
  otpStore.commitSend(scopes);
  return res.json({ ok: true });
});

app.post('/verify', (req, res) => {
  const { discordId, code } = req.body ?? {};

  if (!isNonEmptyString(discordId, 64) || !isNonEmptyString(code, 16)) {
    return res.status(400).json({ ok: false, reason: 'bad_request' });
  }

  const result = otpStore.validateOtp(discordId, code);
  return res.json(result);
});

// Periodically clear stale rows so the tables don't grow unboundedly.
// .unref() so the timer doesn't keep the process alive on shutdown.
const pruneTimer = setInterval(() => {
  try {
    otpStore.pruneExpired();
  } catch (err) {
    log.warn({ err }, 'pruneExpired failed');
  }
}, 60 * 1000);
pruneTimer.unref();

// Bind explicitly to loopback. The OTP service is reached only by the
// bot, on the same VM. Not binding 0.0.0.0 keeps the SMTP-key-holding
// process off the public internet even before any firewall rules.
app.listen(port, '127.0.0.1', () => log.info({ port }, 'OTP service listening'));
