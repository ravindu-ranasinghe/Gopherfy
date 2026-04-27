/**
 * Pragma application tests.
 *
 * The bot's db.js applies a known set of pragmas at module load time.
 * Module-loading actually opens verified.db on the cwd, which is too
 * invasive for a unit test. Instead we apply the pragma sequence to a
 * temp file-backed DB the same way db.js does, then assert the resulting
 * journal_mode is "wal" and that foreign_keys is on.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

function applyPragmas(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

describe('SQLite pragma sequence', () => {
  test('file-backed DB ends up in WAL mode with foreign keys on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gopherfy-db-'));
    const dbPath = path.join(dir, 'test.db');
    const db = new Database(dbPath);
    try {
      applyPragmas(db);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('synchronous', { simple: true })).toBe(1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(':memory: DB accepts the same pragma sequence without throwing', () => {
    const db = new Database(':memory:');
    try {
      expect(() => applyPragmas(db)).not.toThrow();
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });
});
