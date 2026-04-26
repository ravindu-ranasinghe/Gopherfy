/**
 * One-shot backfill: populate verified_users.email_hmac from the still-
 * present plaintext email column. Runs at bot startup, in a single
 * transaction. Safe to re-run -- the WHERE clause skips already-filled
 * rows.
 *
 * After migration 004 drops the email column this function becomes a
 * no-op (the SELECT errors with "no such column"); we tolerate that
 * silently because by then the backfill has already happened.
 */
const crypto = require('crypto');

function emailHmac(hmacKey, email) {
  return crypto.createHmac('sha256', hmacKey).update(email).digest('hex');
}

/**
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {string} args.hmacKey
 * @param {{info: Function, warn?: Function}} [args.log]
 */
function backfillEmailHmac({ db, hmacKey, log }) {
  if (!hmacKey) throw new Error('backfillEmailHmac: hmacKey required');

  // If the email column is already gone, there's nothing to do.
  const cols = db.prepare("PRAGMA table_info('verified_users')").all();
  if (!cols.some((c) => c.name === 'email')) {
    if (log && log.info) log.info('backfill: skipped, email column already dropped');
    return { backfilled: 0, skipped: 0 };
  }

  const rows = db
    .prepare('SELECT discord_id, email, email_hmac FROM verified_users WHERE email IS NOT NULL')
    .all();

  const update = db.prepare('UPDATE verified_users SET email_hmac = ? WHERE discord_id = ?');
  let backfilled = 0;
  let skipped = 0;

  const apply = db.transaction(() => {
    for (const row of rows) {
      if (row.email_hmac) {
        skipped += 1;
        continue;
      }
      update.run(emailHmac(hmacKey, row.email), row.discord_id);
      backfilled += 1;
    }
  });
  apply();

  if (log && log.info) log.info({ backfilled, skipped }, 'backfill: complete');
  return { backfilled, skipped };
}

module.exports = {
  backfillEmailHmac,
  emailHmac,
};
