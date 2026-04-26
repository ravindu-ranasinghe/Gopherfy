/**
 * HMAC-SHA256 request signing for the bot <-> OTP service hop.
 *
 * Wire format:
 *   X-Timestamp: <Unix ms as integer>
 *   X-Signature: <hex of HMAC-SHA256(secret, timestamp + '.' + body)>
 *
 * The signed input is the EXACT bytes of the body that travel on the
 * wire. The verifier must capture req.rawBody from express's json
 * middleware so a re-stringified req.body cannot drift in whitespace.
 *
 * Replay protection: requests older or newer than `clockSkewMs` (default
 * 5 minutes) are rejected.
 */
const crypto = require('crypto');

const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;

function hmacHex(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

function buildSignedPayload(timestamp, body) {
  return `${timestamp}.${body}`;
}

/**
 * Produce the X-Signature value for `(timestamp + '.' + body)`.
 *
 * @param {{secret: string, timestamp: number|string, body: string}} args
 * @returns {string} hex signature
 */
function sign({ secret, timestamp, body }) {
  if (!secret) throw new Error('sign: secret required');
  if (timestamp === undefined || timestamp === null) {
    throw new Error('sign: timestamp required');
  }
  if (typeof body !== 'string') {
    throw new Error('sign: body must be a string');
  }
  return hmacHex(secret, buildSignedPayload(timestamp, body));
}

/**
 * Verify a signature against the supplied timestamp + body.
 *
 * Returns false (never throws) for any malformed input, mismatched
 * lengths, drifted clocks, or signature mismatches. Comparison uses
 * crypto.timingSafeEqual after a length check.
 *
 * @param {object} args
 * @param {string} args.secret
 * @param {string|number|undefined} args.timestamp
 * @param {string} args.body  raw bytes-as-string of the request body
 * @param {string|undefined} args.signature  hex
 * @param {number} [args.clockSkewMs]
 * @param {() => number} [args.now]
 * @returns {boolean}
 */
function verify({
  secret,
  timestamp,
  body,
  signature,
  clockSkewMs = DEFAULT_CLOCK_SKEW_MS,
  now = () => Date.now(),
}) {
  if (!secret) return false;
  if (typeof body !== 'string') return false;
  if (typeof signature !== 'string' || signature.length === 0) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;

  const currentMs = now();
  if (Math.abs(currentMs - ts) > clockSkewMs) return false;

  const expected = hmacHex(secret, buildSignedPayload(ts, body));
  if (expected.length !== signature.length) return false;

  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

module.exports = {
  sign,
  verify,
  DEFAULT_CLOCK_SKEW_MS,
};
