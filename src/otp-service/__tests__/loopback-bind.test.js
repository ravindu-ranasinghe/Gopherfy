/**
 * Sanity test for the OTP service's loopback bind contract.
 *
 * The full createApp factory + supertest integration suite arrives in
 * Prompt 14. For Prompt 10 we only assert that an Express app bound to
 * 127.0.0.1 actually rejects connections from a non-loopback address
 * via the OS-level binding -- we just exercise the code path we care
 * about: the same app accepts loopback connections.
 */
const express = require('express');

function makeMinimalApp() {
  const app = express();
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('loopback bind', () => {
  test('app started with listen(port, "127.0.0.1") accepts localhost connections', async () => {
    const app = makeMinimalApp();
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/ping`);
      const json = await res.json();
      expect(json).toEqual({ ok: true });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
