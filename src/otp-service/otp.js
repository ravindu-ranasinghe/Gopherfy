/**
 * SQLite-backed OTP store and per-scope rate limiter.
 *
 * Pending codes are stored as HMAC-SHA256(hmacKey, code) hex; the
 * plaintext code never touches disk. The verify path recomputes the HMAC
 * and compares with crypto.timingSafeEqual after a length check.
 *
 * Rate limits use a generic otp_send_counter keyed by an opaque scope
 * string (e.g. "user:<discordId>", "email:<hmac>", "ip:<addr>",
 * "whois:<actorId>"). canSend(scopes[]) and commitSend(scopes[]) accept
 * arrays so a single send can debit multiple scopes atomically.
 *
 * The store is dependency-injected (db, hmacKey, clock) for testability.
 */
const crypto = require('crypto');

const DEFAULT_OTP_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SEND_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_SEND_LIMIT = 3;
const DEFAULT_MAX_VERIFY_ATTEMPTS = 5;

function generateCode() {
  return String(crypto.randomInt(100000, 1000000)).padStart(6, '0');
}

function hmacHex(hmacKey, value) {
  return crypto.createHmac('sha256', hmacKey).update(value).digest('hex');
}

/**
 * Construct an OTP store backed by a better-sqlite3 Database.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.hmacKey
 * @param {() => number} [opts.clock]
 * @param {number} [opts.otpTtlMs]
 * @param {number} [opts.sendWindowMs]
 * @param {number} [opts.sendLimit]  legacy single-scope limit; per-scope
 *   limits are passed through canSend/commitSend's options.
 * @param {number} [opts.maxVerifyAttempts]
 */
function createOtpStore(opts) {
  if (!opts || !opts.db) {
    throw new Error('createOtpStore: db is required');
  }
  if (!opts.hmacKey || typeof opts.hmacKey !== 'string' || opts.hmacKey.length < 32) {
    throw new Error('createOtpStore: hmacKey must be a string of length >= 32');
  }

  const {
    db,
    hmacKey,
    clock = () => Date.now(),
    otpTtlMs = DEFAULT_OTP_TTL_MS,
    sendWindowMs = DEFAULT_SEND_WINDOW_MS,
    sendLimit = DEFAULT_SEND_LIMIT,
    maxVerifyAttempts = DEFAULT_MAX_VERIFY_ATTEMPTS,
  } = opts;

  const stmtUpsertPending = db.prepare(
    `INSERT INTO otp_pending (discord_id, email, code_hmac, expires_at, attempts, created_at)
     VALUES (@discordId, @email, @codeHmac, @expiresAt, 0, @createdAt)
     ON CONFLICT(discord_id) DO UPDATE SET
       email = excluded.email,
       code_hmac = excluded.code_hmac,
       expires_at = excluded.expires_at,
       attempts = 0,
       created_at = excluded.created_at`,
  );
  const stmtGetPending = db.prepare('SELECT * FROM otp_pending WHERE discord_id = ?');
  const stmtIncrementAttempts = db.prepare(
    'UPDATE otp_pending SET attempts = attempts + 1 WHERE discord_id = ?',
  );
  const stmtDeletePending = db.prepare('DELETE FROM otp_pending WHERE discord_id = ?');
  const stmtPruneExpiredPending = db.prepare('DELETE FROM otp_pending WHERE expires_at < ?');
  const stmtPruneExpiredCounter = db.prepare('DELETE FROM otp_send_counter WHERE reset_at < ?');

  const stmtGetCounter = db.prepare('SELECT * FROM otp_send_counter WHERE scope_key = ?');
  const stmtUpsertCounter = db.prepare(
    `INSERT INTO otp_send_counter (scope_key, count, reset_at)
     VALUES (@scopeKey, 1, @resetAt)
     ON CONFLICT(scope_key) DO UPDATE SET count = count + 1`,
  );
  const stmtResetCounter = db.prepare(
    `INSERT INTO otp_send_counter (scope_key, count, reset_at)
     VALUES (@scopeKey, 1, @resetAt)
     ON CONFLICT(scope_key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
  );

  function readScope(scopeKey, now) {
    const row = stmtGetCounter.get(scopeKey);
    if (!row) return null;
    if (row.reset_at <= now) return null;
    return row;
  }

  /**
   * Check that all scopes are under their (per-scope) limits.
   *
   * @param {string[]} scopes
   * @param {{limits?: Record<string, number>, defaultLimit?: number}} [options]
   *   limits maps scope prefix (e.g. "user", "email", "ip") -> number of
   *   sends allowed per window. defaultLimit applies if a scope's prefix
   *   has no specific limit.
   * @returns {{ allowed: boolean, retryAfterMs?: number, scope?: string }}
   */
  function canSend(scopes, options = {}) {
    const list = Array.isArray(scopes) ? scopes : [scopes];
    const now = clock();
    const limits = options.limits || {};
    const defaultLimit = options.defaultLimit ?? sendLimit;

    let blockingRetry = 0;
    let blockingScope = null;
    for (const scope of list) {
      const prefix = scope.split(':')[0];
      const limit = limits[prefix] ?? defaultLimit;
      const row = readScope(scope, now);
      if (row && row.count >= limit) {
        const retry = row.reset_at - now;
        if (retry > blockingRetry) {
          blockingRetry = retry;
          blockingScope = scope;
        }
      }
    }

    if (blockingScope) {
      return { allowed: false, retryAfterMs: blockingRetry, scope: blockingScope };
    }
    return { allowed: true };
  }

  /**
   * Atomically debit each scope (insert or increment). Resets the row
   * window when the prior reset_at has passed.
   *
   * @param {string[]} scopes
   */
  function commitSend(scopes) {
    const list = Array.isArray(scopes) ? scopes : [scopes];
    const now = clock();
    const resetAt = now + sendWindowMs;
    const apply = db.transaction(() => {
      for (const scopeKey of list) {
        const existing = stmtGetCounter.get(scopeKey);
        if (!existing || existing.reset_at <= now) {
          stmtResetCounter.run({ scopeKey, resetAt });
        } else {
          stmtUpsertCounter.run({ scopeKey, resetAt: existing.reset_at });
        }
      }
    });
    apply();
  }

  /**
   * Persist a pending OTP for `discordId`. Stores HMAC of the code, never
   * the plaintext.
   */
  function storeOtp(discordId, email, code) {
    const now = clock();
    stmtUpsertPending.run({
      discordId,
      email,
      codeHmac: hmacHex(hmacKey, code),
      expiresAt: now + otpTtlMs,
      createdAt: now,
    });
  }

  /**
   * Check `inputCode` against the stored HMAC for `discordId`.
   *
   * Behavior matches the original in-memory store:
   * - no row -> no_pending
   * - row past expiry -> deleted, expired
   * - wrong code, attempts < max -> wrong_code
   * - wrong code, attempts >= max -> deleted, too_many_attempts
   * - correct code -> deleted, ok with email
   */
  function validateOtp(discordId, inputCode) {
    const row = stmtGetPending.get(discordId);
    if (!row) {
      return { ok: false, reason: 'no_pending' };
    }
    const now = clock();
    if (now >= row.expires_at) {
      stmtDeletePending.run(discordId);
      return { ok: false, reason: 'expired' };
    }

    stmtIncrementAttempts.run(discordId);
    const attempts = row.attempts + 1;

    const expected = Buffer.from(row.code_hmac, 'utf8');
    let provided;
    if (typeof inputCode !== 'string' || inputCode.length === 0) {
      // Length-mismatch path -- timingSafeEqual must never see different
      // sized buffers, so short-circuit to wrong_code.
      provided = null;
    } else {
      provided = Buffer.from(hmacHex(hmacKey, inputCode), 'utf8');
    }

    let matches = false;
    if (provided && provided.length === expected.length) {
      matches = crypto.timingSafeEqual(provided, expected);
    }

    if (!matches) {
      if (attempts >= maxVerifyAttempts) {
        stmtDeletePending.run(discordId);
        return { ok: false, reason: 'too_many_attempts' };
      }
      return { ok: false, reason: 'wrong_code' };
    }

    stmtDeletePending.run(discordId);
    return { ok: true, email: row.email };
  }

  /**
   * Public for tests and the periodic timer in index.js. Removes pending
   * OTPs whose expires_at is in the past, and counters whose window has
   * closed.
   */
  function pruneExpired() {
    const now = clock();
    const r1 = stmtPruneExpiredPending.run(now);
    const r2 = stmtPruneExpiredCounter.run(now);
    return { pendingRemoved: r1.changes, countersRemoved: r2.changes };
  }

  return {
    generateCode,
    canSend,
    commitSend,
    storeOtp,
    validateOtp,
    pruneExpired,
    hmacCode: (code) => hmacHex(hmacKey, code),
  };
}

module.exports = {
  createOtpStore,
  generateCode,
  hmacHex,
};
