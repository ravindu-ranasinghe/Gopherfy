-- 006_deletion_audit.sql -- aggregate proof-of-deletion records. Holds
-- only the discord ID + reason + timestamp; intentionally cannot
-- re-identify the deleted user beyond their snowflake.
CREATE TABLE deletion_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id TEXT NOT NULL,
  reason     TEXT NOT NULL,
  deleted_at INTEGER NOT NULL
);

CREATE INDEX idx_deletion_audit_subject ON deletion_audit(subject_id);
