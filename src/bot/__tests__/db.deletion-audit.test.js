/**
 * Data-layer tests for the deletion_audit table created by migration
 * 006. Insertion shape, index existence.
 */
const path = require('path');
const Database = require('better-sqlite3');

const { runMigrations } = require('../../lib/migrations');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'migrations');

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

describe('deletion_audit data layer', () => {
  test('insert + retrieve preserves shape', () => {
    const db = freshDb();
    const insert = db.prepare(
      'INSERT INTO deletion_audit (subject_id, reason, deleted_at) VALUES (?, ?, ?)',
    );
    insert.run('user1', 'user_request', 1_700_000_000_000);
    const rows = db.prepare('SELECT * FROM deletion_audit').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject_id: 'user1',
      reason: 'user_request',
      deleted_at: 1_700_000_000_000,
    });
  });

  test('subject index exists', () => {
    const db = freshDb();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='deletion_audit'")
      .all()
      .map((r) => r.name);
    expect(idx).toContain('idx_deletion_audit_subject');
  });
});
