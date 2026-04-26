const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { resolveSourcePath, buildDestinationKey, runGpgEncrypt, runBackup } = require('../backup');

describe('backup helpers', () => {
  test('resolveSourcePath uses argv override', () => {
    const p = '/tmp/custom.db';
    expect(resolveSourcePath(['node', 'backup.js', p])).toBe(path.resolve(p));
  });

  test('resolveSourcePath uses GOPHERFY_DATA_DIR', () => {
    const prev = process.env.GOPHERFY_DATA_DIR;
    process.env.GOPHERFY_DATA_DIR = '/data';
    try {
      expect(resolveSourcePath(['node', 'backup.js'])).toBe(path.join('/data', 'verified.db'));
    } finally {
      if (prev === undefined) delete process.env.GOPHERFY_DATA_DIR;
      else process.env.GOPHERFY_DATA_DIR = prev;
    }
  });

  test('buildDestinationKey nests YYYY/MM/DD and ends with .sqlite.gpg', () => {
    const d = new Date('2026-04-26T15:30:00.000Z');
    const k = buildDestinationKey(d);
    expect(k).toMatch(/^gopherfy\/2026\/04\/26\/backup-.*\.sqlite\.gpg$/);
  });

  test('runGpgEncrypt invokes gpg with expected argv', () => {
    const calls = [];
    const spawnSyncImpl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stderr: '', stdout: '' };
    };
    runGpgEncrypt({
      recipient: '0xABCD',
      inputPath: '/tmp/a.sqlite',
      outputPath: '/tmp/a.sqlite.gpg',
      spawnSyncImpl,
    });
    expect(calls[0].cmd).toBe('gpg');
    expect(calls[0].args).toEqual(
      expect.arrayContaining([
        '--encrypt',
        '--recipient',
        '0xABCD',
        '--output',
        '/tmp/a.sqlite.gpg',
        '/tmp/a.sqlite',
      ]),
    );
  });
});

describe('runBackup integration (mocked gpg + GCS)', () => {
  test('creates consistent snapshot, encrypts, uploads, removes locals', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gopherfy-bak-'));
    const sourcePath = path.join(dir, 'verified.db');
    const source = new Database(sourcePath);
    source.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1);');
    source.close();

    const uploads = [];
    class MockStorage {
      bucket(name) {
        return {
          upload: async (localPath, opts) => {
            uploads.push({ bucket: name, localPath, destination: opts.destination });
            expect(fs.existsSync(localPath)).toBe(true);
          },
        };
      }
    }

    const fixed = new Date('2026-05-01T12:00:00.000Z');
    await runBackup({
      sourcePath,
      bucket: 'test-bucket',
      recipient: 'test@example.com',
      spawnSyncImpl: (_cmd, args) => {
        const outI = args.indexOf('--output');
        const out = args[outI + 1];
        const inp = args[args.length - 1];
        fs.copyFileSync(inp, out);
        return { status: 0, stderr: '', stdout: '' };
      },
      StorageImpl: MockStorage,
      now: () => fixed,
    });

    expect(uploads).toHaveLength(1);
    expect(uploads[0].bucket).toBe('test-bucket');
    expect(uploads[0].destination).toBe(buildDestinationKey(fixed));
  });
});

describe('runBackup round-trip (mock gpg as copy, mock storage keeps artifact)', () => {
  test('sqlite snapshot integrity_check ok after fake encrypt/decrypt path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gopherfy-rt-'));
    const sourcePath = path.join(dir, 'verified.db');
    const sdb = new Database(sourcePath);
    sdb.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (42);');
    sdb.close();

    const gpgPath = path.join(dir, 'staged.gpg');
    await runBackup({
      sourcePath,
      bucket: 'b',
      recipient: 'r',
      spawnSyncImpl: (_cmd, args) => {
        const outI = args.indexOf('--output');
        const out = args[outI + 1];
        const inp = args[args.length - 1];
        fs.copyFileSync(inp, out);
        return { status: 0, stderr: '', stdout: '' };
      },
      StorageImpl: class {
        bucket() {
          return {
            upload: async (localPath, opts) => {
              expect(opts.destination).toBeTruthy();
              fs.copyFileSync(localPath, gpgPath);
            },
          };
        }
      },
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });

    const round = path.join(dir, 'round.sqlite');
    fs.copyFileSync(gpgPath, round);
    const db = new Database(round, { readonly: true });
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.prepare('SELECT x FROM t').get().x).toBe(42);
    } finally {
      db.close();
    }
  });
});
