const crypto = require('crypto');

const OTP_TTL = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const ATTEMPT_WINDOW = 60 * 60 * 1000;

const store = new Map();
const attempts = new Map();

function generateCode() {
  return String(crypto.randomInt(100000, 999999));
}

function checkRateLimit(userId) {
  const now = Date.now();
  const entry = attempts.get(userId);

  if (!entry || now >= entry.resetAt) {
    attempts.set(userId, { count: 1, resetAt: now + ATTEMPT_WINDOW });
    return true;
  }

  if (entry.count >= MAX_ATTEMPTS) {
    return false;
  }

  entry.count += 1;
  return true;
}

function createOtp(userId, email) {
  const code = generateCode();
  const expiresAt = Date.now() + OTP_TTL;
  store.set(userId, { code, email, expiresAt });

  const timer = setTimeout(() => {
    const current = store.get(userId);
    if (current && current.expiresAt === expiresAt) {
      store.delete(userId);
    }
  }, OTP_TTL);
  timer.unref();

  return code;
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

  if (entry.code !== inputCode) {
    return { ok: false, reason: 'wrong_code' };
  }

  store.delete(userId);
  return { ok: true, email: entry.email };
}

module.exports = { generateCode, checkRateLimit, createOtp, validateOtp };
