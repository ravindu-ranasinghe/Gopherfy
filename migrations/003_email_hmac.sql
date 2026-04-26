-- 003_email_hmac.sql -- introduce email_hmac alongside the existing
-- email column. Backfill happens at process startup
-- (src/lib/backfill-email-hmac.js); the next migration drops the
-- plaintext email column.
ALTER TABLE verified_users ADD COLUMN email_hmac TEXT;
CREATE UNIQUE INDEX idx_verified_users_email_hmac ON verified_users(email_hmac);
