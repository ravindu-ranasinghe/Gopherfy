-- 007_restore_email_lookup.sql -- re-introduce a nullable plaintext email
-- column for moderation lookup and "already verified" UX messaging.
-- Existing rows will remain NULL unless they verify again.
ALTER TABLE verified_users ADD COLUMN email TEXT;
