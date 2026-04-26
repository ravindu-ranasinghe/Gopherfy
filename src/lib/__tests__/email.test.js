/**
 * validateUmnEmail tests.
 *
 * Combines explicit positive and negative cases (the easy-to-read,
 * high-signal documentation of intent) with two fast-check property
 * tests:
 *   - any "<local>@<sub>.umn.edu" should be accepted as long as the
 *     parts are well-shaped.
 *   - any "<local>@<anything>" where anything is not exactly umn.edu and
 *     not *.umn.edu must be rejected, in particular the
 *     "umn.edu.<other>" lookalike.
 */
const fc = require('fast-check');
const { validateUmnEmail, normalize, MAX_EMAIL_LENGTH } = require('../email');

describe('validateUmnEmail (positive cases)', () => {
  test.each([
    'alice@umn.edu',
    'BOB@UMN.EDU',
    '  spaced@umn.edu  ',
    'cs.user@cs.umn.edu',
    'user@morris.umn.edu',
    'user@deeply.nested.subdomain.umn.edu',
    'user.with.dots@umn.edu',
    'user+tag@umn.edu',
    'a-b_c@umn.edu',
  ])('accepts %s', (email) => {
    const r = validateUmnEmail(email);
    expect(r.valid).toBe(true);
    expect(r.email).toBe(normalize(email));
    expect(r.email.endsWith('umn.edu')).toBe(true);
  });
});

describe('validateUmnEmail (negative cases)', () => {
  test.each([
    ['', 'empty'],
    ['plainaddress', 'bad_shape'],
    ['no@umn.com', 'not_umn'],
    ['no@umn.edu.evil.com', 'not_umn'],
    ['no@umnxedu', 'bad_domain'],
    ['no@.umn.edu', 'bad_domain'],
    ['no@umn..edu', 'bad_domain'],
    ['@umn.edu', 'bad_local'],
    ['user@', 'bad_domain'],
    ['user@@umn.edu', 'bad_shape'],
    ['user with space@umn.edu', 'bad_local'],
    ['user@umn .edu', 'bad_domain'],
  ])('rejects %s', (email, reason) => {
    const r = validateUmnEmail(email);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe(reason);
  });

  test('rejects non-string input', () => {
    expect(validateUmnEmail(undefined).valid).toBe(false);
    expect(validateUmnEmail(null).valid).toBe(false);
    expect(validateUmnEmail(42).valid).toBe(false);
  });

  test(`rejects emails longer than ${MAX_EMAIL_LENGTH} characters`, () => {
    const local = 'a'.repeat(MAX_EMAIL_LENGTH);
    const r = validateUmnEmail(`${local}@umn.edu`);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('too_long');
  });
});

describe('validateUmnEmail (property tests)', () => {
  // fast-check-friendly arbitraries for label characters: ASCII letters,
  // digits, and hyphen (no leading/trailing hyphen).
  const labelStart = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''));
  const labelMid = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split(''));

  const arbLabel = fc
    .tuple(labelStart, fc.array(labelMid, { minLength: 0, maxLength: 5 }), labelStart)
    .map(([s, mid, e]) => s + mid.join('') + e);

  const arbLocal = fc
    .tuple(
      labelStart,
      fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789._-'.split('')), {
        minLength: 0,
        maxLength: 8,
      }),
      labelStart,
    )
    .map(([s, mid, e]) => s + mid.join('') + e)
    .filter((s) => s.length > 0 && s.length <= 64);

  test('any well-shaped "<local>@<sub>.umn.edu" is accepted', () => {
    fc.assert(
      fc.property(arbLocal, fc.array(arbLabel, { minLength: 0, maxLength: 3 }), (local, subs) => {
        const subPart = subs.length > 0 ? subs.join('.') + '.' : '';
        const email = `${local}@${subPart}umn.edu`;
        if (email.length > MAX_EMAIL_LENGTH) return true;
        const r = validateUmnEmail(email);
        return r.valid === true;
      }),
      { numRuns: 200 },
    );
  });

  test('"<local>@umn.edu.<anything>" is always rejected', () => {
    fc.assert(
      fc.property(arbLocal, arbLabel, (local, suffix) => {
        const email = `${local}@umn.edu.${suffix}`;
        const r = validateUmnEmail(email);
        return r.valid === false;
      }),
      { numRuns: 200 },
    );
  });

  test('domains that contain "umn.edu" but are not exactly or a subdomain of umn.edu are rejected', () => {
    fc.assert(
      fc.property(arbLocal, arbLabel, (local, prefix) => {
        // e.g. "user@notumn.edu", "user@umnedu.org"
        const email = `${local}@${prefix}umn.edu`;
        const r = validateUmnEmail(email);
        // Only acceptable if the prefix produces *.umn.edu (i.e. ends with a
        // dot) which the arbitrary doesn't generate. So expect false.
        return r.valid === false || (r.valid && r.domain === 'umn.edu');
      }),
      { numRuns: 200 },
    );
  });
});

describe('normalize', () => {
  test('lowercases and trims', () => {
    expect(normalize('  Alice@UMN.EDU\n')).toBe('alice@umn.edu');
  });

  test('returns empty string for non-string input', () => {
    expect(normalize(undefined)).toBe('');
    expect(normalize(null)).toBe('');
    expect(normalize(42)).toBe('');
  });
});
