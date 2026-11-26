import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../helper';
import { RATE_LIMITS } from '../../src/plugins/rateLimit';

test('GET /health returns API health status', async (t) => {
  const app = await build(t);

  const response = await app.inject({
    method: 'GET',
    url: '/health',
  });

  assert.equal(response.statusCode, 200);
  assert.deepStrictEqual(response.json(), {
    status: 'ok',
  });
  assert.match(response.headers['content-type'] ?? '', /^application\/json/);
});

test('GET /health returns 429 after the global rate limit is exceeded', async (t) => {
  const app = await build(t);
  const health = () => app.inject({ method: 'GET', url: '/health' });

  for (let i = 0; i < RATE_LIMITS.global.max; i++) {
    const response = await health();
    assert.equal(response.statusCode, 200, `request ${i + 1}`);
    assert.equal(
      response.headers['x-ratelimit-remaining'],
      String(RATE_LIMITS.global.max - i - 1),
    );
  }

  const limited = await health();
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(limited.json().statusCode, 429);
});
