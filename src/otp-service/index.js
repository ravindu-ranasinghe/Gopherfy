require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { generateCode, canSend, commitSend, storeOtp, validateOtp } = require('./otp');
const { sendOtp } = require('./email');

const app = express();
app.use(express.json({ limit: '1kb' }));

const port = process.env.OTP_SERVICE_PORT || 3001;
const serviceKey = process.env.OTP_SERVICE_KEY;

if (!serviceKey || serviceKey.length < 32) {
  console.error('OTP_SERVICE_KEY missing or too short (need >=32 chars). Refusing to start.');
  process.exit(1);
}

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

  if (!canSend(discordId)) {
    return res.json({ ok: false, reason: 'rate_limited' });
  }

  const code = generateCode();

  try {
    await sendOtp(email, code);
  } catch (err) {
    console.error('sendOtp failed:', err.message);
    return res.json({ ok: false, reason: 'send_failed' });
  }

  storeOtp(discordId, email, code);
  commitSend(discordId);
  return res.json({ ok: true });
});

app.post('/verify', (req, res) => {
  const { discordId, code } = req.body ?? {};

  if (!isNonEmptyString(discordId, 64) || !isNonEmptyString(code, 16)) {
    return res.status(400).json({ ok: false, reason: 'bad_request' });
  }

  const result = validateOtp(discordId, code);
  return res.json(result);
});

app.listen(port, () => console.log(`OTP service running on port ${port}`));
