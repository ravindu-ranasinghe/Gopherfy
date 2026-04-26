/**
 * Forward-only SQLite migration runner driven by PRAGMA user_version.
 *
 * Conventions:
 * - Migration files live in `migrationsDir` and are named NNN_name.sql
 *   where NNN is a strictly increasing 3-digit decimal version.
 * - PRAGMA user_version on a fresh database is 0; every applied migration
 *   bumps it to the file's version number.
 * - Each migration runs inside a SQLite transaction. Any thrown error
 *   rolls the transaction back and re-throws so the caller can fail fast.
 * - The runner is idempotent: re-running with no new files is a no-op.
 *
 * The runner intentionally does NOT support rollbacks or "down" migrations
 * (forward-only) and refuses to use timestamps in filenames -- the
 * 3-digit prefix is the only ordering primitive.
 */
const fs = require('fs');
const path = require('path');

const FILENAME_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;

/**
 * Read and validate the migration directory contents.
 *
 * @param {string} migrationsDir
 * @returns {{version: number, file: string, fullPath: string}[]} sorted
 *   ascending by version.
 */
function loadMigrations(migrationsDir) {
  let entries;
  try {
    entries = fs.readdirSync(migrationsDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const migrations = [];
  for (const file of entries) {
    if (file.startsWith('.')) continue;
    if (!file.endsWith('.sql')) continue;
    const match = FILENAME_RE.exec(file);
    if (!match) {
      throw new Error(
        `Invalid migration filename: "${file}" (expected NNN_name.sql with a 3-digit prefix)`,
      );
    }
    const version = parseInt(match[1], 10);
    migrations.push({
      version,
      file,
      fullPath: path.join(migrationsDir, file),
    });
  }

  migrations.sort((a, b) => a.version - b.version);

  for (let i = 0; i < migrations.length; i++) {
    if (migrations[i].version === 0) {
      throw new Error(`Migration version must be >=1 (got ${migrations[i].file})`);
    }
    if (i > 0 && migrations[i].version === migrations[i - 1].version) {
      throw new Error(
        `Duplicate migration version ${migrations[i].version}: ${migrations[i - 1].file} and ${migrations[i].file}`,
      );
    }
  }

  return migrations;
}

function getCurrentVersion(db) {
  const row = db.pragma('user_version', { simple: true });
  return typeof row === 'number' ? row : Number(row);
}

/**
 * Apply all pending migrations from `migrationsDir` against `db`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} migrationsDir
 * @param {{info: Function}} [log]
 */
function runMigrations(db, migrationsDir, log) {
  const migrations = loadMigrations(migrationsDir);
  const current = getCurrentVersion(db);
  const pending = migrations.filter((m) => m.version > current);

  if (pending.length === 0) {
    if (log && typeof log.info === 'function') {
      log.info({ version: current }, 'migrations: up to date');
    }
    return { applied: 0, version: current };
  }

  let version = current;
  for (const migration of pending) {
    if (migration.version !== version + 1) {
      throw new Error(
        `Migration version gap: have user_version=${version}, next file is ${migration.file} (version ${migration.version}); expected ${version + 1}`,
      );
    }
    const sql = fs.readFileSync(migration.fullPath, 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
    if (log && typeof log.info === 'function') {
      log.info({ from: version, to: migration.version, file: migration.file }, 'migration applied');
    }
    version = migration.version;
  }

  return { applied: pending.length, version };
}

module.exports = {
  runMigrations,
  loadMigrations,
};
