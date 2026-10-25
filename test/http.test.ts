import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';

import { createMcpHttpServer } from '../src/http.js';
import { createFitbitServer } from '../src/server.js';

test('HTTP MCP listens on 127.0.0.1:8788 and rejects other hosts', async () => {
  const server = createMcpHttpServer(() => createFitbitServer({ configDir: '/tmp/fitbit-air-mcp-http-test' }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(8788, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(address.address, '127.0.0.1');
    assert.equal(address.port, 8788);
    assert.equal(await status({ path: '/', method: 'GET' }), 404);
    assert.equal(await status({ path: '/mcp', method: 'POST', headers: { host: 'evil.example', origin: 'https://evil.example' } }), 403);
    const local = await status({ path: '/mcp', method: 'POST', headers: { host: '127.0.0.1:8788', 'content-type': 'application/json' }, body: '{}' });
    assert.notEqual(local, 403);
    assert.notEqual(local, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function status(options: { path: string; method: string; headers?: Record<string, string>; body?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: 8788, path: options.path, method: options.method, headers: options.headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.setTimeout(5000, () => {
      req.destroy(new Error('HTTP test timed out'));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
