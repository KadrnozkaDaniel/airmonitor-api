import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../helper';

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
