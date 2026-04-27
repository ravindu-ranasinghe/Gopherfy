/**
 * Round-trip tests for HMAC-SHA256 request signing.
 *
 * Covers: deterministic round-trip, body tampering, wrong secret, clock
 * drift past skew window, header length-mismatch, and missing headers.
 */
const { sign, verify } = require('../http-signing');

const SECRET = 'a'.repeat(64);
const ALT_SECRET = 'b'.repeat(64);

describe('http-signing round trip', () => {
  test('verify accepts a signature produced by sign with the same secret/body/timestamp', () => {
    const ts = 1_700_000_000_000;
    const body = JSON.stringify({ discordId: 'u', email: 'a@umn.edu' });
    const sig = sign({ secret: SECRET, timestamp: ts, body });
    expect(verify({ secret: SECRET, timestamp: ts, body, signature: sig, now: () => ts })).toBe(
      true,
    );
  });

  test('tampered body fails verification', () => {
    const ts = 1_700_000_000_000;
    const sig = sign({ secret: SECRET, timestamp: ts, body: '{"x":1}' });
    expect(
      verify({
        secret: SECRET,
        timestamp: ts,
        body: '{"x":2}',
        signature: sig,
        now: () => ts,
      }),
    ).toBe(false);
  });

  test('wrong secret fails verification', () => {
    const ts = 1_700_000_000_000;
    const body = '{}';
    const sig = sign({ secret: SECRET, timestamp: ts, body });
    expect(verify({ secret: ALT_SECRET, timestamp: ts, body, signature: sig, now: () => ts })).toBe(
      false,
    );
  });

  test('clock drift past 5 minutes fails verification', () => {
    const ts = 1_700_000_000_000;
    const sig = sign({ secret: SECRET, timestamp: ts, body: '{}' });
    expect(
      verify({
        secret: SECRET,
        timestamp: ts,
        body: '{}',
        signature: sig,
        now: () => ts + 6 * 60 * 1000,
      }),
    ).toBe(false);
    expect(
      verify({
        secret: SECRET,
        timestamp: ts,
        body: '{}',
        signature: sig,
        now: () => ts - 6 * 60 * 1000,
      }),
    ).toBe(false);
  });

  test('drift inside the 5-minute window passes', () => {
    const ts = 1_700_000_000_000;
    const sig = sign({ secret: SECRET, timestamp: ts, body: '{}' });
    expect(
      verify({
        secret: SECRET,
        timestamp: ts,
        body: '{}',
        signature: sig,
        now: () => ts + 4 * 60 * 1000,
      }),
    ).toBe(true);
  });

  test('mismatched signature length fails before timing-safe compare', () => {
    expect(
      verify({
        secret: SECRET,
        timestamp: 1_700_000_000_000,
        body: '{}',
        signature: 'short',
        now: () => 1_700_000_000_000,
      }),
    ).toBe(false);
  });

  test('missing or non-string inputs return false instead of throwing', () => {
    expect(verify({ secret: SECRET, timestamp: undefined, body: '{}', signature: 'x' })).toBe(
      false,
    );
    expect(verify({ secret: '', timestamp: 1, body: '{}', signature: 'x' })).toBe(false);
    expect(verify({ secret: SECRET, timestamp: 1, body: 123, signature: 'x' })).toBe(false);
    expect(verify({ secret: SECRET, timestamp: 1, body: '{}', signature: undefined })).toBe(false);
  });

  test('sign throws on missing inputs', () => {
    expect(() => sign({ secret: '', timestamp: 1, body: '{}' })).toThrow();
    expect(() => sign({ secret: SECRET, timestamp: undefined, body: '{}' })).toThrow();
    expect(() => sign({ secret: SECRET, timestamp: 1, body: 123 })).toThrow();
  });
});
