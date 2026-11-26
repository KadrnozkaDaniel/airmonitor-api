import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  serializerCompiler,
  validatorCompiler,
} from '@fastify/type-provider-zod';
import type { PrismaClient } from '../../../prisma/generated/client';
import appPlugin from '../../../src/app';
import type {} from '../../../src/plugins/auth';
import type {} from '../../../src/plugins/deviceAuth';
import type {} from '../../../src/plugins/prisma';
import rateLimitPlugin, { RATE_LIMITS } from '../../../src/plugins/rateLimit';
import measurementRoutes from '../../../src/routes/measurements';
import {
  listMeasurementsResponseSchema,
  measurementResponseSchema,
} from '../../../src/schemas/measurement.schema';
import { generateApiKey } from '../../../src/utils/api-key';
import {
  ECO2_MAX,
  ECO2_MIN,
  MAX_BATCH_SIZE,
  MAX_CLOCK_SKEW_MS,
  MAX_MEASUREMENT_AGE_MS,
  TVOC_MAX,
} from '../../../src/utils/constants';
import { createTestAuth, newIdentity } from '../../auth';

const deviceHeaders = (key: string) => ({ authorization: `Bearer ${key}` });

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const withOffset = (iso: string) =>
  new Date(Date.parse(iso) + 60 * 60_000).toISOString().replace('Z', '+01:00');

const reading = (minutes: number, overrides: Record<string, unknown> = {}) => ({
  eco2: 450,
  tvoc: 12,
  measuredAt: minutesAgo(minutes),
  ...overrides,
});

async function setup(t: TestContext) {
  const app = Fastify();
  const auth = await createTestAuth();
  const karel = { id: randomUUID(), ...newIdentity('karel') };
  const jan = { id: randomUUID(), ...newIdentity('jan') };
  const userIds = [karel.id, jan.id];
  const deviceId = randomUUID();
  const otherDeviceId = randomUUID();
  const deviceKey = generateApiKey();
  const otherDeviceKey = generateApiKey();

  t.after(async () => {
    try {
      if (app.hasDecorator('prisma')) {
        await app.prisma.measurement.deleteMany({
          where: { device: { ownerId: { in: userIds } } },
        });
        await app.prisma.device.deleteMany({
          where: { ownerId: { in: userIds } },
        });
        await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
    } finally {
      await app.close();
    }
  });

  await app.register(fp(appPlugin), { authJwks: auth.jwks });
  await app.ready();
  await app.prisma.user.createMany({
    data: [karel, jan].map(({ id, sub, email }) => ({
      id,
      email,
      keycloakSubject: sub,
    })),
  });
  await app.prisma.device.createMany({
    data: [
      { id: deviceId, apiKeyHash: deviceKey.hash },
      { id: otherDeviceId, apiKeyHash: otherDeviceKey.hash },
    ].map((device) => ({
      ...device,
      name: 'Test device',
      ownerId: karel.id,
    })),
  });

  return {
    app,
    deviceId,
    otherDeviceId,
    device: deviceHeaders(deviceKey.key),
    otherDevice: deviceHeaders(otherDeviceKey.key),
    karel: { ...karel, headers: await auth.authHeader(karel) },
    jan: { ...jan, headers: await auth.authHeader(jan) },
  };
}

const ingest = (
  app: Awaited<ReturnType<typeof setup>>['app'],
  headers: Record<string, string>,
  payload: unknown,
) =>
  app.inject({
    method: 'POST',
    url: '/measurements',
    headers,
    payload: payload as Record<string, unknown>,
  });

test('POST /measurements stores a batch and GET returns the saved data', async (t) => {
  const { app, deviceId, device, karel } = await setup(t);
  const measurements = [
    reading(3, { eco2: 500, tvoc: 10 }),
    reading(2, { eco2: 600, tvoc: 20 }),
    { eco2: 700, tvoc: 30, measuredAt: withOffset(minutesAgo(1)) },
  ];

  const response = await ingest(app, device, { measurements });

  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.headers['content-type'] ?? '', /application\/json/);
  assert.deepEqual(response.json(), {
    received: 3,
    inserted: 3,
    duplicates: 0,
  });

  const saved = await app.prisma.measurement.findMany({
    where: { deviceId },
    orderBy: { measuredAt: 'asc' },
  });
  assert.deepEqual(
    saved.map(({ eco2, tvoc, measuredAt }) => ({
      eco2,
      tvoc,
      measuredAt: measuredAt.toISOString(),
    })),
    measurements.map(({ eco2, tvoc, measuredAt }) => ({
      eco2,
      tvoc,
      measuredAt: new Date(measuredAt).toISOString(),
    })),
  );

  const list = await app.inject({
    method: 'GET',
    url: `/measurements?deviceId=${deviceId}`,
    headers: karel.headers,
  });
  assert.equal(list.statusCode, 200, list.body);
  const { data, pagination } = listMeasurementsResponseSchema.parse(
    list.json(),
  );
  assert.deepEqual(
    data.map((measurement) => measurement.eco2),
    [700, 600, 500],
  );
  assert.equal(pagination.total, 3);
});

test('POST /measurements is idempotent when the same batch is sent again', async (t) => {
  const { app, deviceId, device } = await setup(t);
  const measurements = [reading(3), reading(2), reading(1)];

  const first = await ingest(app, device, { measurements });
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { received: 3, inserted: 3, duplicates: 0 });

  const retry = await ingest(app, device, { measurements });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.deepEqual(retry.json(), { received: 3, inserted: 0, duplicates: 3 });

  const changed = await ingest(app, device, {
    measurements: measurements.map((measurement) => ({
      ...measurement,
      eco2: 999,
    })),
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(changed.json(), {
    received: 3,
    inserted: 0,
    duplicates: 3,
  });

  const saved = await app.prisma.measurement.findMany({ where: { deviceId } });
  assert.equal(saved.length, 3);
  assert.ok(saved.every((measurement) => measurement.eco2 === 450));
});

test('POST /measurements stores only new measurements from an overlapping batch', async (t) => {
  const { app, deviceId, device, otherDevice } = await setup(t);
  const [older, middle, newest] = [minutesAgo(3), minutesAgo(2), minutesAgo(1)];

  const first = await ingest(app, device, {
    measurements: [
      { eco2: 450, tvoc: 12, measuredAt: older },
      { eco2: 450, tvoc: 12, measuredAt: middle },
    ],
  });
  assert.equal(first.statusCode, 200, first.body);

  const overlapping = await ingest(app, device, {
    measurements: [
      { eco2: 450, tvoc: 12, measuredAt: withOffset(middle) },
      { eco2: 450, tvoc: 12, measuredAt: newest },
    ],
  });
  assert.equal(overlapping.statusCode, 200, overlapping.body);
  assert.deepEqual(overlapping.json(), {
    received: 2,
    inserted: 1,
    duplicates: 1,
  });
  assert.equal(await app.prisma.measurement.count({ where: { deviceId } }), 3);

  const fromOtherDevice = await ingest(app, otherDevice, {
    measurements: [{ eco2: 450, tvoc: 12, measuredAt: middle }],
  });
  assert.equal(fromOtherDevice.statusCode, 200, fromOtherDevice.body);
  assert.equal(fromOtherDevice.json().inserted, 1);
});

test('POST /measurements accepts values and times at their limits', async (t) => {
  const { app, deviceId, device } = await setup(t);
  const skewMinutes = MAX_CLOCK_SKEW_MS / 60_000;
  const maxAgeMinutes = MAX_MEASUREMENT_AGE_MS / 60_000;

  const response = await ingest(app, device, {
    measurements: [
      reading(4, { eco2: ECO2_MIN, tvoc: 0 }),
      reading(3, { eco2: ECO2_MAX, tvoc: TVOC_MAX }),
      reading(-(skewMinutes - 1)),
      reading(maxAgeMinutes - 60),
    ],
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    received: 4,
    inserted: 4,
    duplicates: 0,
  });
  assert.equal(await app.prisma.measurement.count({ where: { deviceId } }), 4);
});

test('POST /measurements accepts a batch of the maximum size', async (t) => {
  const { app, deviceId, device } = await setup(t);

  const response = await ingest(app, device, {
    measurements: Array.from({ length: MAX_BATCH_SIZE }, (_, index) =>
      reading(index + 1),
    ),
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    received: MAX_BATCH_SIZE,
    inserted: MAX_BATCH_SIZE,
    duplicates: 0,
  });
  assert.equal(
    await app.prisma.measurement.count({ where: { deviceId } }),
    MAX_BATCH_SIZE,
  );
});

test('POST /measurements rejects invalid batches without writing to the database', async (t) => {
  const { app, deviceId, otherDeviceId, device } = await setup(t);
  const valid = reading(1);
  const skewMinutes = MAX_CLOCK_SKEW_MS / 60_000;
  const maxAgeMinutes = MAX_MEASUREMENT_AGE_MS / 60_000;
  const batch = (...items: unknown[]) => ({ measurements: items });

  const cases: [string, unknown][] = [
    ['empty body', {}],
    ['single measurement without batch', valid],
    ['empty batch', batch()],
    ['measurements is not an array', { measurements: valid }],
    [
      'batch over the limit',
      {
        measurements: Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, index) =>
          reading(index + 1),
        ),
      },
    ],
    ['unknown top-level field', { ...batch(valid), deviceId }],
    ['missing eco2', batch({ tvoc: 12, measuredAt: valid.measuredAt })],
    ['missing tvoc', batch({ eco2: 450, measuredAt: valid.measuredAt })],
    ['missing measuredAt', batch({ eco2: 450, tvoc: 12 })],
    ['eco2 below range', batch(reading(1, { eco2: ECO2_MIN - 1 }))],
    ['eco2 above range', batch(reading(1, { eco2: ECO2_MAX + 1 }))],
    ['eco2 not an integer', batch(reading(1, { eco2: 450.5 }))],
    ['eco2 as string', batch(reading(1, { eco2: '450' }))],
    ['eco2 null', batch(reading(1, { eco2: null }))],
    ['tvoc negative', batch(reading(1, { tvoc: -1 }))],
    ['tvoc above range', batch(reading(1, { tvoc: TVOC_MAX + 1 }))],
    ['measuredAt invalid', batch(reading(1, { measuredAt: 'not-a-date' }))],
    ['measuredAt date only', batch(reading(1, { measuredAt: '2026-01-01' }))],
    ['measuredAt in the future', batch(reading(-(skewMinutes + 1)))],
    ['measuredAt too old', batch(reading(maxAgeMinutes + 60))],
    [
      'measuredAt from 1970',
      batch(reading(1, { measuredAt: new Date(0).toISOString() })),
    ],
    ['deviceId in measurement', batch(reading(1, { deviceId: otherDeviceId }))],
    ['id in measurement', batch(reading(1, { id: randomUUID() }))],
    [
      'receivedAt in measurement',
      batch(reading(1, { receivedAt: new Date().toISOString() })),
    ],
    ['duplicate measuredAt in batch', batch(valid, { ...valid, eco2: 999 })],
    [
      'duplicate instant with another offset',
      batch(valid, { ...valid, measuredAt: withOffset(valid.measuredAt) }),
    ],
    [
      'one invalid item among valid ones',
      batch(reading(3), reading(2, { eco2: 1 })),
    ],
  ];

  for (const [label, payload] of cases) {
    const response = await ingest(app, device, payload);
    assert.equal(response.statusCode, 400, `${label}: ${response.body}`);
    assert.equal(response.json().statusCode, 400, label);
    assert.equal(response.json().error, 'Bad Request', label);
    assert.doesNotMatch(response.body, /Prisma|stack/i, label);
  }

  assert.equal(
    await app.prisma.measurement.count({
      where: { deviceId: { in: [deviceId, otherDeviceId] } },
    }),
    0,
  );
});

test('POST /measurements rejects bodies over the size limit', async (t) => {
  const { app, deviceId, device } = await setup(t);

  const response = await ingest(app, device, {
    measurements: [reading(1, { note: 'x'.repeat(300 * 1024) })],
  });

  assert.equal(response.statusCode, 413, response.body);
  assert.equal(response.json().statusCode, 413);
  assert.equal(await app.prisma.measurement.count({ where: { deviceId } }), 0);
});

test('POST /measurements returns 401 without a valid device key', async (t) => {
  const { app, deviceId, otherDeviceId, device, karel } = await setup(t);
  const deviceKey = device.authorization.slice('Bearer '.length);
  const legacyDeviceId = randomUUID();
  await app.prisma.device.create({
    data: { id: legacyDeviceId, name: 'Legacy device', ownerId: karel.id },
  });

  const cases: [string, Record<string, string>][] = [
    ['missing header', {}],
    ['basic auth', { authorization: `Basic ${deviceKey}` }],
    ['empty bearer', { authorization: 'Bearer ' }],
    ['raw key without bearer', { authorization: deviceKey }],
    ['unknown key', deviceHeaders(generateApiKey().key)],
    ['key without prefix', deviceHeaders(deviceKey.slice('amk_'.length))],
    ['tampered key', deviceHeaders(`${deviceKey}x`)],
    ['stored hash as key', deviceHeaders(generateApiKey().hash)],
    ['user token', karel.headers],
  ];

  for (const [label, headers] of cases) {
    const response = await ingest(app, headers, {
      measurements: [reading(1)],
    });
    assert.equal(response.statusCode, 401, `${label}: ${response.body}`);
    assert.equal(response.json().statusCode, 401, label);
    assert.doesNotMatch(response.body, /amk_|Prisma|stack/i, label);
  }

  assert.equal(
    await app.prisma.measurement.count({
      where: { deviceId: { in: [deviceId, otherDeviceId, legacyDeviceId] } },
    }),
    0,
  );
  const devices = await app.prisma.device.findMany({
    where: { id: { in: [deviceId, otherDeviceId, legacyDeviceId] } },
  });
  assert.ok(devices.every((saved) => saved.lastSeenAt === null));
});

test('POST /measurements stores the batch under the device of the key', async (t) => {
  const { app, deviceId, otherDeviceId, otherDevice } = await setup(t);

  const response = await ingest(app, otherDevice, {
    measurements: [reading(2), reading(1)],
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    await app.prisma.measurement.count({ where: { deviceId: otherDeviceId } }),
    2,
  );
  assert.equal(await app.prisma.measurement.count({ where: { deviceId } }), 0);
});

test('POST /measurements updates lastSeenAt of the device', async (t) => {
  const { app, deviceId, otherDeviceId, device, karel } = await setup(t);

  const before = new Date();
  const response = await ingest(app, device, { measurements: [reading(1)] });
  const after = new Date();
  assert.equal(response.statusCode, 200, response.body);

  const saved = await app.prisma.device.findUniqueOrThrow({
    where: { id: deviceId },
  });
  assert.ok(saved.lastSeenAt, 'lastSeenAt should be set');
  assert.ok(saved.lastSeenAt >= new Date(before.getTime() - 1));
  assert.ok(saved.lastSeenAt <= after);

  const other = await app.prisma.device.findUniqueOrThrow({
    where: { id: otherDeviceId },
  });
  assert.equal(other.lastSeenAt, null);

  const detail = await app.inject({
    method: 'GET',
    url: `/devices/${deviceId}`,
    headers: karel.headers,
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().lastSeenAt, saved.lastSeenAt.toISOString());
});

test('POST /measurements rejects the old key after rotation and accepts the new one', async (t) => {
  const { app, deviceId, device, karel } = await setup(t);
  const [first, second, third] = [minutesAgo(3), minutesAgo(2), minutesAgo(1)];

  const beforeRotation = await ingest(app, device, {
    measurements: [{ eco2: 450, tvoc: 12, measuredAt: first }],
  });
  assert.equal(beforeRotation.statusCode, 200, beforeRotation.body);

  const rotation = await app.inject({
    method: 'POST',
    url: `/devices/${deviceId}/api-key`,
    headers: karel.headers,
  });
  assert.equal(rotation.statusCode, 200, rotation.body);
  const { apiKey } = rotation.json();

  const oldKey = await ingest(app, device, {
    measurements: [{ eco2: 450, tvoc: 12, measuredAt: second }],
  });
  assert.equal(oldKey.statusCode, 401, oldKey.body);

  const newKey = await ingest(app, deviceHeaders(apiKey), {
    measurements: [{ eco2: 450, tvoc: 12, measuredAt: third }],
  });
  assert.equal(newKey.statusCode, 200, newKey.body);

  const saved = await app.prisma.measurement.findMany({
    where: { deviceId },
    orderBy: { measuredAt: 'asc' },
  });
  assert.deepEqual(
    saved.map((measurement) => measurement.measuredAt.toISOString()),
    [first, third],
  );
});

test('POST /measurements returns 429 after the device exceeds the rate limit', async (t) => {
  const { app, deviceId, device } = await setup(t);
  const payload = { measurements: [reading(1)] };

  for (let i = 0; i < RATE_LIMITS.deviceIngest.max; i++) {
    const response = await ingest(app, device, payload);
    assert.equal(
      response.statusCode,
      200,
      `request ${i + 1}: ${response.body}`,
    );
  }

  const limited = await ingest(app, device, {
    measurements: [reading(2)],
  });

  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(limited.json().statusCode, 429);
  assert.equal(limited.json().error, 'Too Many Requests');
  assert.match(limited.json().message, /Rate limit exceeded/);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal(await app.prisma.measurement.count({ where: { deviceId } }), 1);
});

test('POST /measurements counts requests with invalid keys before authenticating', async (t) => {
  const { app, device } = await setup(t);
  const unknownKey = deviceHeaders(generateApiKey().key);

  for (let i = 0; i < RATE_LIMITS.deviceIngest.max; i++) {
    const response = await ingest(app, unknownKey, {
      measurements: [reading(1)],
    });
    assert.equal(
      response.statusCode,
      401,
      `request ${i + 1}: ${response.body}`,
    );
  }

  const invalid = await ingest(app, unknownKey, {
    measurements: [reading(1)],
  });
  assert.equal(invalid.statusCode, 429, invalid.body);

  const valid = await ingest(app, device, { measurements: [reading(1)] });
  assert.equal(valid.statusCode, 429, valid.body);
});

test('GET /measurements returns saved measurements with serialized dates', async (t) => {
  const { app, deviceId, karel } = await setup(t);
  const measurement = await app.prisma.measurement.create({
    data: {
      deviceId,
      eco2: 500,
      tvoc: 10,
      measuredAt: new Date('2026-01-01T12:00:00.000Z'),
      receivedAt: new Date('2026-01-01T12:00:05.000Z'),
    },
  });

  const response = await app.inject({
    method: 'GET',
    url: `/measurements?deviceId=${deviceId}`,
    headers: karel.headers,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.headers['content-type'] ?? '', /application\/json/);
  const body = response.json();
  listMeasurementsResponseSchema.parse(body);
  assert.deepEqual(body, {
    data: [
      {
        id: measurement.id,
        eco2: measurement.eco2,
        tvoc: measurement.tvoc,
        measuredAt: measurement.measuredAt.toISOString(),
        receivedAt: measurement.receivedAt.toISOString(),
      },
    ],
    pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
  });
});

test('GET /measurements filters devices and paginates newest measurements first', async (t) => {
  const { app, deviceId, otherDeviceId, karel } = await setup(t);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  await app.prisma.measurement.createMany({
    data: [
      ...ids.map((id, index) => ({
        id,
        deviceId,
        eco2: 500 + index,
        tvoc: 10 + index,
        measuredAt: new Date(`2026-01-0${index + 1}T12:00:00.000Z`),
      })),
      {
        deviceId: otherDeviceId,
        eco2: 900,
        tvoc: 90,
        measuredAt: new Date('2026-01-04T12:00:00.000Z'),
      },
    ],
  });

  for (const [page, expectedIds] of [
    [1, [ids[2], ids[1]]],
    [2, [ids[0]]],
    [3, []],
  ] as const) {
    const response = await app.inject({
      method: 'GET',
      url: `/measurements?deviceId=${deviceId}&page=${page}&limit=2`,
      headers: karel.headers,
    });

    assert.equal(response.statusCode, 200, response.body);
    const { data, pagination } = listMeasurementsResponseSchema.parse(
      response.json(),
    );
    assert.deepEqual(
      data.map((measurement) => measurement.id),
      expectedIds,
    );
    assert.deepEqual(pagination, { page, limit: 2, total: 3, totalPages: 2 });
  }
});

test('GET /measurements filters by an inclusive measuredAt range', async (t) => {
  const { app, deviceId, karel } = await setup(t);
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await app.prisma.measurement.createMany({
    data: ids.map((id, index) => ({
      id,
      deviceId,
      eco2: 500,
      tvoc: 10,
      measuredAt: new Date(`2026-01-0${index + 1}T12:00:00.000Z`),
    })),
  });

  for (const [query, expectedIds] of [
    ['from=2026-01-02T12:00:00.000Z', [ids[3], ids[2], ids[1]]],
    ['to=2026-01-02T12:00:00.000Z', [ids[1], ids[0]]],
    [
      'from=2026-01-02T12:00:00.000Z&to=2026-01-03T12:00:00.000Z',
      [ids[2], ids[1]],
    ],
    [
      'from=2026-01-03T13:00:00%2B01:00&to=2026-01-03T13:00:00%2B01:00',
      [ids[2]],
    ],
    ['from=2026-01-05T00:00:00Z', []],
  ] as const) {
    const response = await app.inject({
      method: 'GET',
      url: `/measurements?deviceId=${deviceId}&${query}`,
      headers: karel.headers,
    });

    assert.equal(response.statusCode, 200, `${query}: ${response.body}`);
    const { data, pagination } = listMeasurementsResponseSchema.parse(
      response.json(),
    );
    assert.deepEqual(
      data.map((measurement) => measurement.id),
      expectedIds,
      query,
    );
    assert.equal(pagination.total, expectedIds.length, query);
  }
});

test('GET /measurements returns an empty list for a device without measurements', async (t) => {
  const { app, deviceId, karel } = await setup(t);
  const response = await app.inject({
    method: 'GET',
    url: `/measurements?deviceId=${deviceId}`,
    headers: karel.headers,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    data: [],
    pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
  });
});

test('GET /measurements limits results to the default page size', async (t) => {
  const { app, deviceId, karel } = await setup(t);
  await app.prisma.measurement.createMany({
    data: Array.from({ length: 11 }, (_, index) => ({
      deviceId,
      eco2: 500,
      tvoc: 10,
      measuredAt: new Date(Date.UTC(2026, 0, 1, 12, index)),
    })),
  });

  const response = await app.inject({
    method: 'GET',
    url: `/measurements?deviceId=${deviceId}`,
    headers: karel.headers,
  });

  assert.equal(response.statusCode, 200, response.body);
  const { data, pagination } = listMeasurementsResponseSchema.parse(
    response.json(),
  );
  assert.equal(data.length, 10);
  assert.deepEqual(pagination, {
    page: 1,
    limit: 10,
    total: 11,
    totalPages: 2,
  });
});

test('GET /measurements returns 404 for a nonexistent device', async (t) => {
  const { app, karel } = await setup(t);
  const response = await app.inject({
    method: 'GET',
    url: `/measurements?deviceId=${randomUUID()}`,
    headers: karel.headers,
  });

  assert.equal(response.statusCode, 404, response.body);
  assert.deepEqual(response.json(), {
    statusCode: 404,
    error: 'Not Found',
    message: 'Device does not exist',
  });
});

test('GET /measurements rejects missing, invalid and unknown query parameters', async (t) => {
  const { app, deviceId, karel } = await setup(t);
  const invalidQueries = [
    '',
    'deviceId=invalid-uuid',
    'deviceId=',
    ...[
      'page=0',
      'page=-1',
      'page=1.5',
      'page=1000001',
      'page=abc',
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=abc',
      'unknown=value',
      'from=not-a-date',
      'from=2026-01-01',
      'to=2026-01-01T12:00:00',
      'from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z',
      'from=2026-01-01T02:00:00%2B01:00&to=2026-01-01T00:30:00Z',
    ].map((query) => `deviceId=${deviceId}&${query}`),
  ];

  for (const query of invalidQueries) {
    const response = await app.inject({
      method: 'GET',
      url: `/measurements?${query}`,
      headers: karel.headers,
    });

    assert.equal(response.statusCode, 400, `${query}: ${response.body}`);
    assert.equal(response.json().statusCode, 400);
    assert.equal(response.json().error, 'Bad Request');
    assert.doesNotMatch(response.body, /Prisma|stack/i);
  }
});

test('GET /measurements/latest returns the newest measurement of the device', async (t) => {
  const { app, deviceId, otherDeviceId, karel } = await setup(t);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  await app.prisma.measurement.createMany({
    data: [
      ...ids.map((id, index) => ({
        id,
        deviceId,
        eco2: 500 + index,
        tvoc: 10 + index,
        measuredAt: new Date(`2026-01-0${3 - index}T12:00:00.000Z`),
      })),
      {
        deviceId: otherDeviceId,
        eco2: 900,
        tvoc: 90,
        measuredAt: new Date('2026-01-04T12:00:00.000Z'),
      },
    ],
  });

  const response = await app.inject({
    method: 'GET',
    url: `/measurements/latest?deviceId=${deviceId}`,
    headers: karel.headers,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.headers['content-type'] ?? '', /application\/json/);
  const body = measurementResponseSchema.parse(response.json());
  const saved = await app.prisma.measurement.findUniqueOrThrow({
    where: { id: ids[0] },
  });
  assert.deepEqual(body, {
    id: saved.id,
    eco2: saved.eco2,
    tvoc: saved.tvoc,
    measuredAt: saved.measuredAt.toISOString(),
    receivedAt: saved.receivedAt.toISOString(),
  });
});

test('GET /measurements/latest returns 404 for a device without measurements', async (t) => {
  const { app, deviceId, karel } = await setup(t);
  const response = await app.inject({
    method: 'GET',
    url: `/measurements/latest?deviceId=${deviceId}`,
    headers: karel.headers,
  });

  assert.equal(response.statusCode, 404, response.body);
  assert.deepEqual(response.json(), {
    statusCode: 404,
    error: 'Not Found',
    message: 'Measurement does not exist',
  });
});

test('GET /measurements/latest returns 404 for a nonexistent device', async (t) => {
  const { app, karel } = await setup(t);
  const response = await app.inject({
    method: 'GET',
    url: `/measurements/latest?deviceId=${randomUUID()}`,
    headers: karel.headers,
  });

  assert.equal(response.statusCode, 404, response.body);
  assert.deepEqual(response.json(), {
    statusCode: 404,
    error: 'Not Found',
    message: 'Device does not exist',
  });
});

test('GET /measurements/latest rejects missing, invalid and unknown query parameters', async (t) => {
  const { app, deviceId, karel } = await setup(t);
  const invalidQueries = [
    '',
    'deviceId=invalid-uuid',
    'deviceId=',
    `deviceId=${deviceId}&unknown=value`,
    `deviceId=${deviceId}&page=1`,
  ];

  for (const query of invalidQueries) {
    const response = await app.inject({
      method: 'GET',
      url: `/measurements/latest?${query}`,
      headers: karel.headers,
    });

    assert.equal(response.statusCode, 400, `${query}: ${response.body}`);
    assert.equal(response.json().statusCode, 400);
    assert.equal(response.json().error, 'Bad Request');
    assert.doesNotMatch(response.body, /Prisma|stack/i);
  }
});

test('GET /measurements routes return 401 without a valid token', async (t) => {
  const { app, deviceId } = await setup(t);

  for (const headers of [
    {} as Record<string, string>,
    { authorization: 'Bearer not-a-jwt' },
  ]) {
    for (const url of [
      `/measurements?deviceId=${deviceId}`,
      `/measurements/latest?deviceId=${deviceId}`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers });
      assert.equal(response.statusCode, 401, `${url}: ${response.body}`);
      assert.equal(response.json().statusCode, 401);
    }
  }
});

test("GET /measurements returns 404 for another user's device", async (t) => {
  const { app, deviceId, karel, jan } = await setup(t);
  await app.prisma.measurement.create({
    data: {
      deviceId,
      eco2: 500,
      tvoc: 10,
      measuredAt: new Date('2026-01-01T12:00:00.000Z'),
    },
  });

  for (const url of [
    `/measurements?deviceId=${deviceId}`,
    `/measurements/latest?deviceId=${deviceId}`,
  ]) {
    const foreign = await app.inject({
      method: 'GET',
      url,
      headers: jan.headers,
    });
    assert.equal(foreign.statusCode, 404, `${url}: ${foreign.body}`);
    assert.deepEqual(foreign.json(), {
      statusCode: 404,
      error: 'Not Found',
      message: 'Device does not exist',
    });
    assert.doesNotMatch(foreign.body, /eco2|tvoc|measuredAt/);

    const own = await app.inject({
      method: 'GET',
      url,
      headers: karel.headers,
    });
    assert.equal(own.statusCode, 200, `${url}: ${own.body}`);
  }
});

for (const { method, stage } of [
  { method: 'POST', stage: 'batch insert' },
  { method: 'GET', stage: 'device lookup' },
  { method: 'GET', stage: 'measurement query' },
  { method: 'GET', stage: 'latest measurement query' },
] as const) {
  test(`${method} /measurements hides unexpected database errors during ${stage}`, async (t) => {
    const app = Fastify();
    t.after(() => app.close());
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const deviceId = randomUUID();
    const fail = async () => {
      throw new Error('Sensitive database connection details');
    };
    app.decorate('prisma', {
      device: {
        findUnique:
          stage === 'device lookup' ? fail : async () => ({ id: deviceId }),
      },
      measurement: {
        createMany: fail,
        findFirst: fail,
        findMany: async () => [],
        count: async () => 0,
      },
      $transaction: fail,
    } as unknown as PrismaClient);
    app.decorateRequest('device', null);
    app.decorate('authenticateDevice', async (request: FastifyRequest) => {
      request.device = { id: deviceId, ownerId: randomUUID() };
    });
    app.decorateRequest('user', null);
    app.decorate('authenticate', async (request: FastifyRequest) => {
      request.user = {
        id: randomUUID(),
        keycloakSubject: randomUUID(),
        email: 'stub@test.cz',
      };
    });
    await app.register(rateLimitPlugin);
    await app.register(measurementRoutes, { prefix: '/measurements' });

    const response = await app.inject(
      method === 'POST'
        ? {
            method,
            url: '/measurements',
            payload: { measurements: [reading(1)] },
          }
        : stage === 'latest measurement query'
          ? { method, url: `/measurements/latest?deviceId=${deviceId}` }
          : { method, url: `/measurements?deviceId=${deviceId}` },
    );

    assert.equal(response.statusCode, 500, response.body);
    assert.deepEqual(response.json(), {
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    });
    assert.doesNotMatch(response.body, /Sensitive|Prisma|stack/i);
  });
}
