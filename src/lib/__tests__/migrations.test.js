/**
 * Migration runner tests.
 *
 * Each test gets its own :memory: database and a freshly minted temp
 * directory of .sql files. We assert the runner advances PRAGMA
 * user_version, applies files in order, rolls back on errors, refuses to
 * load malformed filenames, and is a no-op when nothing is pending.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runMigrations, loadMigrations } = require('../migrations');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gopherfy-migrations-'));
}

function writeMigration(dir, filename, sql) {
  fs.writeFileSync(path.join(dir, filename), sql);
}

describe('runMigrations', () => {
  let dir;
  let db;

  beforeEach(() => {
    dir = makeTempDir();
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('applies a single migration to a fresh DB and bumps user_version', () => {
    writeMigration(dir, '001_init.sql', 'CREATE TABLE thing (id INTEGER PRIMARY KEY);');
    const result = runMigrations(db, dir);
    expect(result.applied).toBe(1);
    expect(result.version).toBe(1);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables.map((t) => t.name)).toContain('thing');
  });

  test('is a no-op on an up-to-date DB', () => {
    writeMigration(dir, '001_init.sql', 'CREATE TABLE thing (id INTEGER PRIMARY KEY);');
    runMigrations(db, dir);
    const result = runMigrations(db, dir);
    expect(result.applied).toBe(0);
    expect(result.version).toBe(1);
  });

  test('applies migrations in filename (version) order', () => {
    writeMigration(dir, '001_a.sql', 'CREATE TABLE a (id INTEGER);');
    writeMigration(dir, '002_b.sql', 'CREATE TABLE b (id INTEGER);');
    const result = runMigrations(db, dir);
    expect(result.applied).toBe(2);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['a', 'b']));
  });

  test('rolls back the transaction on error and leaves user_version unchanged', () => {
    writeMigration(
      dir,
      '001_broken.sql',
      'CREATE TABLE good (id INTEGER); INSERT INTO nonexistent (x) VALUES (1);',
    );
    expect(() => runMigrations(db, dir)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables.map((t) => t.name)).not.toContain('good');
  });

  test('rejects malformed filenames at scan time', () => {
    writeMigration(dir, 'foo.sql', 'CREATE TABLE x (id INTEGER);');
    expect(() => loadMigrations(dir)).toThrow(/Invalid migration filename/);
  });

  test('rejects 1-digit prefix filenames', () => {
    writeMigration(dir, '1_initial.sql', 'CREATE TABLE x (id INTEGER);');
    expect(() => loadMigrations(dir)).toThrow(/Invalid migration filename/);
  });

  test('rejects gaps in version numbers', () => {
    writeMigration(dir, '001_a.sql', 'CREATE TABLE a (id INTEGER);');
    writeMigration(dir, '003_skip.sql', 'CREATE TABLE c (id INTEGER);');
    expect(() => runMigrations(db, dir)).toThrow(/Migration version gap/);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
  });

  test('returns empty result when migrations directory does not exist', () => {
    const missing = path.join(dir, 'does-not-exist');
    const result = runMigrations(db, missing);
    expect(result).toEqual({ applied: 0, version: 0 });
  });

  test('skips already-applied migrations on a non-fresh DB', () => {
    writeMigration(dir, '001_a.sql', 'CREATE TABLE a (id INTEGER);');
    writeMigration(dir, '002_b.sql', 'CREATE TABLE b (id INTEGER);');
    runMigrations(db, dir);
    writeMigration(dir, '003_c.sql', 'CREATE TABLE c (id INTEGER);');
    const result = runMigrations(db, dir);
    expect(result.applied).toBe(1);
    expect(result.version).toBe(3);
  });
});
