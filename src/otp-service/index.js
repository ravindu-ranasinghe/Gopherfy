require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { runMigrations } = require('../lib/migrations');
const { createOtpStore } = require('./otp');
const { sendOtp } = require('./email');
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

const app = express();
app.use(express.json({ limit: '1kb' }));

app.use((req, res, next) => {
  res.on('finish', () => {
    log.info({ method: req.method, path: req.path, status: res.statusCode }, 'request');
  });
  next();
});

const expectedAuthHash = crypto.createHash('sha256').update(`Bearer ${serviceKey}`).digest();

function isAuthed(req) {
  const header = req.get('authorization');
  if (!header) return false;
  const providedHash = crypto.createHash('sha256').update(header).digest();
  return crypto.timingSafeEqual(providedHash, expectedAuthHash);
}

function isNonEmptyString(v, maxLen) {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

app.use((req, res, next) => {
  if (!isAuthed(req)) {
    return res.status(401).json({ ok: false, reason: 'unauthorized' });
  }
  next();
});

app.post('/send', async (req, res) => {
  const { discordId, email } = req.body ?? {};

  if (!isNonEmptyString(discordId, 64) || !isNonEmptyString(email, 320)) {
    return res.status(400).json({ ok: false, reason: 'bad_request' });
  }

  const userScope = `user:${discordId}`;
  const gate = otpStore.canSend([userScope]);
  if (!gate.allowed) {
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
  otpStore.commitSend([userScope]);
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

app.listen(port, () => log.info({ port }, 'OTP service listening'));
