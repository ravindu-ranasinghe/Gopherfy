/**
 * Secret loader.
 *
 * Two modes, picked by NODE_ENV:
 *   - development/test: read each secret from process.env (existing
 *     dotenv-driven workflow).
 *   - production: fetch each secret from GCP Secret Manager, addressed
 *     by `projects/${GCP_PROJECT_ID}/secrets/${name}/versions/latest`.
 *     The "latest" alias makes secret rotation a one-click operation
 *     (disable old version, add new -> next restart picks it up).
 *     Pinning to a numeric version is recommended for highly
 *     consequential changes; see README "Secret rotation".
 *
 * loadSecrets() is idempotent and cached. Callers should `await` it
 * once at boot and pass the returned frozen object into module setup;
 * no other code in this repo should read process.env for any of the
 * SECRET_NAMES below.
 */
const SECRET_NAMES = ['DISCORD_TOKEN', 'OTP_SERVICE_KEY', 'OTP_HMAC_KEY', 'RESEND_API_KEY'];

let cached = null;

function isProduction(env = process.env) {
  return env.NODE_ENV === 'production';
}

async function fetchFromSecretManager(client, projectId, name) {
  const [version] = await client.accessSecretVersion({
    name: `projects/${projectId}/secrets/${name}/versions/latest`,
  });
  const payload = version.payload?.data;
  if (!payload) {
    throw new Error(`secret ${name} returned an empty payload`);
  }
  return Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
}

/**
 * Resolve every entry in SECRET_NAMES.
 *
 * @param {object} [opts]
 * @param {object} [opts.env=process.env] - env source (test injection)
 * @param {object} [opts.client]          - SecretManagerServiceClient (test injection)
 * @param {string} [opts.projectId]       - GCP project id (defaults to env.GCP_PROJECT_ID)
 * @returns {Promise<Readonly<Record<string,string>>>}
 */
async function loadSecrets({ env = process.env, client, projectId } = {}) {
  if (cached) return cached;

  const result = {};

  if (!isProduction(env)) {
    for (const name of SECRET_NAMES) {
      result[name] = env[name] ?? '';
    }
    cached = Object.freeze(result);
    return cached;
  }

  // production
  const pid = projectId ?? env.GCP_PROJECT_ID;
  if (!pid) {
    throw new Error('GCP_PROJECT_ID is required in production');
  }

  let smClient = client;
  if (!smClient) {
    // Lazy-require so dev/test runs don't need the heavy GRPC client.
    const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
    smClient = new SecretManagerServiceClient();
  }

  for (const name of SECRET_NAMES) {
    try {
      result[name] = await fetchFromSecretManager(smClient, pid, name);
    } catch (err) {
      throw new Error(`failed to load secret ${name}: ${err.message}`, { cause: err });
    }
    if (!result[name]) {
      throw new Error(`secret ${name} resolved to empty string`);
    }
  }

  cached = Object.freeze(result);
  return cached;
}

/** For tests only — clears the cached result so the next call re-fetches. */
function _resetCache() {
  cached = null;
}

module.exports = { loadSecrets, _resetCache, SECRET_NAMES };
