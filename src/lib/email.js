/**
 * UMN email parsing + validation.
 *
 * Domain rule: accept exactly `umn.edu` or any subdomain of `umn.edu`
 * (`*.umn.edu`, e.g. `cs.umn.edu`, `morris.umn.edu`). Crucially, the
 * registrable domain check is anchored on `umn.edu` so adversarial
 * lookalikes like `umn.edu.evil.com` are rejected.
 *
 * Length rule: total email length <= 254 chars (RFC 5321 path limit).
 *
 * The local part is sanity-checked (>=1 char, no whitespace), but no
 * heroics: deliverability is the email provider's problem. We only
 * gatekeep the @umn.edu boundary.
 *
 * normalize() lowercases and trims; HMAC and dedupe operate on the
 * normalized form.
 */
const MAX_EMAIL_LENGTH = 254;
const ROOT_DOMAIN = 'umn.edu';

/**
 * Lowercase + trim. Does NOT validate; pair with validateUmnEmail.
 *
 * @param {string} input
 * @returns {string}
 */
function normalize(input) {
  if (typeof input !== 'string') return '';
  return input.trim().toLowerCase();
}

function isValidLocalPart(local) {
  if (!local) return false;
  if (local.length > 64) return false;
  // Reject whitespace and control characters; the rest we leave to the
  // email provider. The control-character class is intentional.
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(local)) return false;
  return true;
}

// LDH (letter-digit-hyphen) label pattern. Splitting into two simpler
// regexes avoids the eslint-plugin-security false positive for the
// quantified inner group while still catching leading/trailing hyphens.
const LABEL_FIRST_LAST_RE = /^[a-z0-9]/;
const LABEL_BODY_RE = /^[a-z0-9-]+$/;

function isValidLabel(label) {
  if (label.length === 0 || label.length > 63) return false;
  if (!LABEL_BODY_RE.test(label)) return false;
  if (!LABEL_FIRST_LAST_RE.test(label)) return false;
  if (!LABEL_FIRST_LAST_RE.test(label[label.length - 1])) return false;
  return true;
}

function isValidDomain(domain) {
  if (!domain) return false;
  if (domain.length > 253) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(domain)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!isValidLabel(label)) return false;
  }
  return true;
}

/**
 * Returns true iff `domain` (already normalized) equals `umn.edu` OR is a
 * subdomain (ends with `.umn.edu`). Bare-suffix matching is intentionally
 * NOT used here: `umn.edu.evil.com` does not end with `.umn.edu`, so
 * stripping label boundaries off matters.
 */
function isUmnDomain(domain) {
  if (domain === ROOT_DOMAIN) return true;
  if (domain.endsWith(`.${ROOT_DOMAIN}`)) return true;
  return false;
}

/**
 * Validate a UMN email.
 *
 * @param {string} input
 * @returns {{ valid: true, email: string, local: string, domain: string } |
 *           { valid: false, reason: string }}
 */
function validateUmnEmail(input) {
  if (typeof input !== 'string') return { valid: false, reason: 'not_a_string' };
  const email = normalize(input);
  if (email.length === 0) return { valid: false, reason: 'empty' };
  if (email.length > MAX_EMAIL_LENGTH) return { valid: false, reason: 'too_long' };

  const atCount = (email.match(/@/g) || []).length;
  if (atCount !== 1) return { valid: false, reason: 'bad_shape' };

  const [local, domain] = email.split('@');
  if (!isValidLocalPart(local)) return { valid: false, reason: 'bad_local' };
  if (!isValidDomain(domain)) return { valid: false, reason: 'bad_domain' };
  if (!isUmnDomain(domain)) return { valid: false, reason: 'not_umn' };

  return { valid: true, email, local, domain };
}

module.exports = {
  normalize,
  validateUmnEmail,
  MAX_EMAIL_LENGTH,
  ROOT_DOMAIN,
};
