-- 005_whois_audit.sql -- audit every successful /whois invocation so
-- abusive moderator behavior can be reviewed via /whois-audit.
CREATE TABLE whois_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id     TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  guild_id     TEXT NOT NULL,
  looked_up_at INTEGER NOT NULL
);

CREATE INDEX idx_whois_audit_actor ON whois_audit(actor_id);
CREATE INDEX idx_whois_audit_target ON whois_audit(target_id);
