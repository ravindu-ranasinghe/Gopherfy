-- 002_otp_pending.sql -- pending OTPs and rate-limit counters move from
-- in-memory Maps to SQLite so they survive a process restart and so
-- multiple scopes (user, email, IP) can be tracked in one table.
--
-- Codes are stored as HMAC-SHA256(OTP_HMAC_KEY, code) hex; the plaintext
-- code never lands on disk.

CREATE TABLE otp_pending (
  discord_id  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  code_hmac   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_otp_pending_expires ON otp_pending(expires_at);

CREATE TABLE otp_send_counter (
  scope_key   TEXT PRIMARY KEY,
  count       INTEGER NOT NULL DEFAULT 0,
  reset_at    INTEGER NOT NULL
);
CREATE INDEX idx_otp_send_counter_reset ON otp_send_counter(reset_at);
