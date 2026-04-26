const crypto = require('crypto');

const OTP_TTL = 10 * 60 * 1000;
const MAX_SENDS = 3;
const SEND_WINDOW = 60 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

const store = new Map();
const sendCounters = new Map();

function generateCode() {
  return String(crypto.randomInt(100000, 1000000)).padStart(6, '0');
}

function pruneSendCounter(userId) {
  const entry = sendCounters.get(userId);
  if (entry && Date.now() >= entry.resetAt) {
    sendCounters.delete(userId);
    return null;
  }
  return entry || null;
}

function canSend(userId) {
  const entry = pruneSendCounter(userId);
  return !entry || entry.count < MAX_SENDS;
}

function commitSend(userId) {
  const now = Date.now();
  const entry = pruneSendCounter(userId);
  if (!entry) {
    sendCounters.set(userId, { count: 1, resetAt: now + SEND_WINDOW });
  } else {
    entry.count += 1;
  }
}

function storeOtp(userId, email, code) {
  const expiresAt = Date.now() + OTP_TTL;
  store.set(userId, { code, email, expiresAt, attempts: 0 });

  const timer = setTimeout(() => {
    const current = store.get(userId);
    if (current && current.expiresAt === expiresAt) {
      store.delete(userId);
    }
  }, OTP_TTL);
  timer.unref();
}

function validateOtp(userId, inputCode) {
  const entry = store.get(userId);
  if (!entry) {
    return { ok: false, reason: 'no_pending' };
  }

  if (Date.now() >= entry.expiresAt) {
    store.delete(userId);
    return { ok: false, reason: 'expired' };
  }

  entry.attempts += 1;

  const stored = Buffer.from(entry.code, 'utf8');
  const provided = Buffer.from(inputCode, 'utf8');
  const matches = stored.length === provided.length && crypto.timingSafeEqual(stored, provided);

  if (!matches) {
    if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
      store.delete(userId);
      return { ok: false, reason: 'too_many_attempts' };
    }
    return { ok: false, reason: 'wrong_code' };
  }

  store.delete(userId);
  return { ok: true, email: entry.email };
}

module.exports = {
  generateCode,
  canSend,
  commitSend,
  storeOtp,
  validateOtp,
};
