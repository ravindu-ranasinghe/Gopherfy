const { loadSecrets, _resetCache, SECRET_NAMES } = require('../secrets');

describe('loadSecrets', () => {
  afterEach(() => {
    _resetCache();
    delete process.env.NODE_ENV;
    delete process.env.GCP_PROJECT_ID;
    SECRET_NAMES.forEach((n) => delete process.env[n]);
  });

  test('development reads from process.env and returns a frozen object', async () => {
    process.env.NODE_ENV = 'development';
    process.env['DISCORD_TOKEN'] = 'd'.repeat(40);
    process.env['OTP_SERVICE_KEY'] = 's'.repeat(40);
    process.env['OTP_HMAC_KEY'] = 'h'.repeat(40);
    process.env['RESEND_API_KEY'] = 'r'.repeat(40);

    const s = await loadSecrets();
    expect(s.DISCORD_TOKEN).toBe('d'.repeat(40));
    expect(s.OTP_SERVICE_KEY).toBe('s'.repeat(40));
    expect(s.OTP_HMAC_KEY).toBe('h'.repeat(40));
    expect(s.RESEND_API_KEY).toBe('r'.repeat(40));
    expect(Object.isFrozen(s)).toBe(true);
  });

  test('production with mocked Secret Manager returns fetched values', async () => {
    process.env.NODE_ENV = 'production';
    process.env.GCP_PROJECT_ID = 'my-proj';

    const accessSecretVersion = jest.fn(async ({ name }) => {
      const m = name.match(/secrets\/([^/]+)\/versions\/latest$/);
      const secretId = m[1];
      const val = {
        DISCORD_TOKEN: 'dtok',
        OTP_SERVICE_KEY: 'skey',
        OTP_HMAC_KEY: 'hkey',
        RESEND_API_KEY: 'rkey',
      }[secretId];
      return [{ payload: { data: Buffer.from(val, 'utf8') } }];
    });

    const client = { accessSecretVersion };

    const s = await loadSecrets({ client, projectId: 'my-proj' });
    expect(s.DISCORD_TOKEN).toBe('dtok');
    expect(accessSecretVersion).toHaveBeenCalledTimes(4);
    expect(accessSecretVersion).toHaveBeenCalledWith({
      name: 'projects/my-proj/secrets/DISCORD_TOKEN/versions/latest',
    });
  });

  test('production missing GCP_PROJECT_ID throws', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.GCP_PROJECT_ID;

    await expect(loadSecrets({ client: { accessSecretVersion: jest.fn() } })).rejects.toThrow(
      'GCP_PROJECT_ID is required',
    );
  });

  test('production empty payload throws with secret name', async () => {
    process.env.NODE_ENV = 'production';
    process.env.GCP_PROJECT_ID = 'p';

    const client = {
      accessSecretVersion: jest.fn(async ({ name }) => {
        if (name.includes('DISCORD_TOKEN')) return [{ payload: {} }];
        return [{ payload: { data: Buffer.from('x') } }];
      }),
    };

    await expect(loadSecrets({ client })).rejects.toThrow(/DISCORD_TOKEN/);
  });

  test('cache: second loadSecrets does not call client again', async () => {
    process.env.NODE_ENV = 'production';
    process.env.GCP_PROJECT_ID = 'p';

    const accessSecretVersion = jest.fn(async () => [{ payload: { data: Buffer.from('v') } }]);
    const client = { accessSecretVersion };

    await loadSecrets({ client });
    await loadSecrets({ client });
    expect(accessSecretVersion).toHaveBeenCalledTimes(4);
  });
});
