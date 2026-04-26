/**
 * Structured logger for Gopherfy.
 *
 * Pino with redaction. PII (email, OTP code, tokens, Discord IDs) must
 * never appear in logs at any level. The redact paths below censor common
 * shapes; nested objects are covered by wildcards. Add to this list when a
 * new sensitive shape ships.
 *
 * In development we render via pino-pretty for readability; in production
 * we emit newline-delimited JSON suitable for any log shipper.
 */
const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || 'info';

const redactPaths = [
  'email',
  'code',
  'token',
  'apiKey',
  'discordId',
  'password',
  'secret',
  'OTP_SERVICE_KEY',
  'OTP_HMAC_KEY',
  'DISCORD_TOKEN',
  'RESEND_API_KEY',
  'req.headers.authorization',
  'req.headers["x-signature"]',
  'req.headers["x-timestamp"]',
  '*.email',
  '*.code',
  '*.token',
  '*.password',
  '*.discordId',
  '*.apiKey',
  '*.secret',
];

const baseOptions = {
  level,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
};

const logger = isProduction
  ? pino(baseOptions)
  : pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });

/**
 * Build a child logger with extra bindings (typically `{ module: '...' }`).
 */
function child(bindings = {}) {
  return logger.child(bindings);
}

module.exports = {
  logger,
  child,
  redactPaths,
};
