'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { Storage } = require('@google-cloud/storage');
const log = require('../src/lib/logger').child({ module: 'restore' });

function runGpgDecrypt({ inputPath, outputPath, spawnSyncImpl = spawnSync }) {
  const r = spawnSyncImpl(
    'gpg',
    ['--batch', '--yes', '--decrypt', '--output', outputPath, inputPath],
    {
      encoding: 'utf8',
    },
  );
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || `gpg decrypt failed with status ${r.status}`);
  }
}

async function listLatestObject(storage, bucketName) {
  const [files] = await storage.bucket(bucketName).getFiles({ prefix: 'gopherfy/' });
  if (!files.length) throw new Error('no backups found under prefix gopherfy/');
  files.sort((a, b) => b.name.localeCompare(a.name));
  return files[0].name;
}

async function main() {
  const arg = process.argv[2];
  const bucket = process.env.BACKUP_GCS_BUCKET;
  if (!bucket) {
    log.error('BACKUP_GCS_BUCKET is required');
    process.exit(1);
  }
  const storage = new Storage();
  let objectName = arg;
  if (!objectName || objectName === 'latest') {
    objectName = await listLatestObject(storage, bucket);
  }

  const tmpGpg = path.join(os.tmpdir(), `gopherfy-restore-${Date.now()}.sqlite.gpg`);
  const tmpSqlite = path.join(os.tmpdir(), `gopherfy-restore-${Date.now()}.sqlite`);

  try {
    await storage.bucket(bucket).file(objectName).download({ destination: tmpGpg });
    runGpgDecrypt({ inputPath: tmpGpg, outputPath: tmpSqlite });
    fs.unlinkSync(tmpGpg);

    const db = new Database(tmpSqlite, { readonly: true });
    try {
      const row = db.pragma('integrity_check', { simple: true });
      if (row !== 'ok') {
        throw new Error(`integrity_check failed: ${row}`);
      }
    } finally {
      db.close();
    }

    process.stdout.write(`${tmpSqlite}\n`);
    log.info(
      { objectName, path: tmpSqlite },
      'restore verified; replace production DB manually if needed',
    );
  } catch (err) {
    try {
      fs.unlinkSync(tmpGpg);
    } catch (_e) {
      /* ignore */
    }
    try {
      fs.unlinkSync(tmpSqlite);
    } catch (_e2) {
      /* ignore */
    }
    log.error({ err }, 'restore failed');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { runGpgDecrypt, listLatestObject };
