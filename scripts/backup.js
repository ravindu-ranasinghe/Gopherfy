'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { Storage } = require('@google-cloud/storage');
const log = require('../src/lib/logger').child({ module: 'backup' });

function resolveSourcePath(argv = process.argv) {
  const arg = argv[2];
  if (arg) return path.resolve(arg);
  return path.join(process.env.GOPHERFY_DATA_DIR || process.cwd(), 'verified.db');
}

function buildDestinationKey(date) {
  const d = date;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const iso = d.toISOString().replace(/[:.]/g, '-');
  return `gopherfy/${y}/${m}/${day}/backup-${iso}.sqlite.gpg`;
}

function runGpgEncrypt({ recipient, inputPath, outputPath, spawnSyncImpl = spawnSync }) {
  const r = spawnSyncImpl(
    'gpg',
    [
      '--batch',
      '--yes',
      '--encrypt',
      '--trust-model',
      'always',
      '--recipient',
      recipient,
      '--output',
      outputPath,
      inputPath,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || `gpg encrypt failed with status ${r.status}`);
  }
}

async function uploadToGcs({ bucketName, localPath, destinationKey, StorageImpl = Storage }) {
  const storage = new StorageImpl();
  await storage.bucket(bucketName).upload(localPath, { destination: destinationKey });
}

async function runBackup(deps = {}) {
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  const StorageImpl = deps.StorageImpl ?? Storage;
  const now = deps.now ?? (() => new Date());

  const sourcePath = deps.sourcePath ?? resolveSourcePath(deps.argv ?? process.argv);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`source database not found: ${sourcePath}`);
  }

  const bucket = deps.bucket ?? process.env.BACKUP_GCS_BUCKET;
  const recipient = deps.recipient ?? process.env.BACKUP_GPG_RECIPIENT;
  if (!bucket) throw new Error('BACKUP_GCS_BUCKET is required');
  if (!recipient) throw new Error('BACKUP_GPG_RECIPIENT is required');

  const t = now();
  const tmpBase = path.join(
    os.tmpdir(),
    `gopherfy-backup-${t.toISOString().replace(/[:.]/g, '-')}`,
  );
  const sqlitePath = `${tmpBase}.sqlite`;
  const gpgPath = `${tmpBase}.sqlite.gpg`;

  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(sqlitePath);
  } finally {
    db.close();
  }

  runGpgEncrypt({ recipient, inputPath: sqlitePath, outputPath: gpgPath, spawnSyncImpl });
  fs.unlinkSync(sqlitePath);

  const destKey = buildDestinationKey(t);
  await uploadToGcs({
    bucketName: bucket,
    localPath: gpgPath,
    destinationKey: destKey,
    StorageImpl,
  });
  fs.unlinkSync(gpgPath);

  log.info({ destKey, bucket }, 'backup completed');
  return { destKey, bucket };
}

async function main() {
  try {
    await runBackup();
  } catch (err) {
    log.error({ err }, 'backup failed');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveSourcePath,
  buildDestinationKey,
  runGpgEncrypt,
  runBackup,
};
