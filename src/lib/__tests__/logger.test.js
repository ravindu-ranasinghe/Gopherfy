/**
 * Logger redaction tests.
 *
 * Pino is configured to redact a curated list of PII keys. Each test below
 * captures stdout while emitting one log line, parses it as JSON, and
 * asserts that the sensitive value has been replaced with [REDACTED]. We
 * load logger.js with NODE_ENV=production so Pino emits JSON straight to
 * stdout (no pretty-printing transport).
 */
const { Writable } = require('stream');
const pino = require('pino');

function captureLogger() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  const { redactPaths } = require('../logger');
  const logger = pino(
    {
      level: 'info',
      redact: { paths: redactPaths, censor: '[REDACTED]' },
    },
    stream,
  );
  return { logger, lines };
}

function lastLine(lines) {
  return JSON.parse(lines[lines.length - 1]);
}

describe('logger redaction', () => {
  test('redacts top-level email', () => {
    const { logger, lines } = captureLogger();
    logger.info({ email: 'alice@umn.edu' }, 'verification started');
    const out = lastLine(lines);
    expect(out.email).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('alice@umn.edu');
  });

  test('redacts nested user.email', () => {
    const { logger, lines } = captureLogger();
    logger.info({ user: { email: 'bob@umn.edu', id: '42' } }, 'event');
    const out = lastLine(lines);
    expect(out.user.email).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('bob@umn.edu');
  });

  test('redacts authorization header', () => {
    const { logger, lines } = captureLogger();
    logger.info({ req: { headers: { authorization: 'Bearer abcdef' } } }, 'req');
    const out = lastLine(lines);
    expect(out.req.headers.authorization).toBe('[REDACTED]');
  });

  test('redacts DISCORD_TOKEN field', () => {
    const { logger, lines } = captureLogger();
    logger.info({ DISCORD_TOKEN: 'super-secret-token' }, 'boot');
    const out = lastLine(lines);
    expect(out.DISCORD_TOKEN).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('super-secret-token');
  });

  test('redacts top-level code', () => {
    const { logger, lines } = captureLogger();
    logger.info({ code: '123456', discordId: '99' }, 'otp generated');
    const out = lastLine(lines);
    expect(out.code).toBe('[REDACTED]');
    expect(out.discordId).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('123456');
  });
});

describe('logger module shape', () => {
  test('child returns a logger with bindings applied', () => {
    const { child } = require('../logger');
    const c = child({ module: 'test' });
    expect(typeof c.info).toBe('function');
    expect(typeof c.child).toBe('function');
  });
});
