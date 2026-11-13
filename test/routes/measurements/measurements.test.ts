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
import type {} from '../../../src/plugins/prisma';
import measurementRoutes from '../../../src/routes/measurements';
import {
  listMeasurementsResponseSchema,
  measurementResponseSchema,
  type MeasurementResponse,
} from '../../../src/schemas/measurement.schema';
import { createTestAuth, newIdentity } from '../../auth';

async function setup(t: TestContext) {
  const app = Fastify();
  const auth = await createTestAuth();
  const karel = { id: randomUUID(), ...newIdentity('karel') };
  const jan = { id: randomUUID(), ...newIdentity('jan') };
  const userIds = [karel.id, jan.id];
  const deviceId = randomUUID();
  const otherDeviceId = randomUUID();
  const deviceIds = [deviceId, otherDeviceId];

  t.after(async () => {
    try {
      if (app.hasDecorator('prisma')) {
        await app.prisma.measurement.deleteMany({
          where: { deviceId: { in: deviceIds } },
        });
        await app.prisma.device.deleteMany({
          where: { id: { in: deviceIds } },
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
    data: deviceIds.map((id) => ({
      id,
      name: 'Test device',
      ownerId: karel.id,
    })),
  });

  return {
    app,
    deviceId,
    otherDeviceId,
    karel: { ...karel, headers: await auth.authHeader(karel) },
    jan: { ...jan, headers: await auth.authHeader(jan) },
  };
}

test('POST /measurements persists a measurement and GET returns the saved data', async (t) => {
  const { app, deviceId, karel } = await setup(t);

  const response = await app.inject({
    method: 'POST',
    url: '/measurements',
    payload: {
      deviceId,
      eco2: 450,
      tvoc: 12,
      measuredAt: '2026-01-01T13:00:00.000+01:00',
    },
  });

  assert.equal(response.statusCode, 201, response.body);
  assert.match(response.headers['content-type'] ?? '', /application\/json/);
  const body = response.json<MeasurementResponse>();
  assert.deepEqual(Object.keys(body).sort(), [
    'eco2',
    'id',
    'measuredAt',
    'receivedAt',
    'tvoc',
  ]);
  assert.match(body.id, /^[0-9a-f-]{36}$/i);
  assert.equal(body.eco2, 450);
  assert.equal(body.tvoc, 12);
  assert.equal(body.measuredAt, '2026-01-01T12:00:00.000Z');
  assert.equal(new Date(body.receivedAt).toISOString(), body.receivedAt);

  const saved = await app.prisma.measurement.findUniqueOrThrow({
    where: { id: body.id },
  });
  assert.equal(saved.deviceId, deviceId);
  assert.deepEqual(body, {
    id: saved.id,
    eco2: saved.eco2,
    tvoc: saved.tvoc,
    measuredAt: saved.measuredAt.toISOString(),
    receivedAt: saved.receivedAt.toISOString(),
  });

  const list = await app.inject({
    method: 'GET',
    url: `/measurements?deviceId=${deviceId}`,
    headers: karel.headers,
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(list.json(), {
    data: [body],
    pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
  });
});

test('POST /measurements rejects invalid bodies without writing to the database', async (t) => {
  const { app, deviceId } = await setup(t);
  const valid = {
    deviceId,
    eco2: 450,
    tvoc: 12,
    measuredAt: '2026-01-01T12:00:00.000Z',
  };
  const invalidBodies = [
    {},
    { eco2: 450, tvoc: 12, measuredAt: valid.measuredAt },
    { deviceId, tvoc: 12, measuredAt: valid.measuredAt },
    { deviceId, eco2: 450, measuredAt: valid.measuredAt },
    { deviceId, eco2: 450, tvoc: 12 },
    { ...valid, deviceId: 'invalid-uuid' },
    { ...valid, eco2: 1.5 },
    { ...valid, eco2: '450' },
    { ...valid, eco2: null },
    { ...valid, tvoc: 1.5 },
    { ...valid, tvoc: 2 ** 31 },
    { ...valid, measuredAt: 'not-a-date' },
    { ...valid, measuredAt: '2026-01-01' },
    { ...valid, id: randomUUID() },
    { ...valid, receivedAt: new Date().toISOString() },
  ];

  for (const payload of invalidBodies) {
    const response = await app.inject({
      method: 'POST',
      url: '/measurements',
      payload,
    });
    assert.equal(
      response.statusCode,
      400,
      `${JSON.stringify(payload)}: ${response.body}`,
    );
    assert.equal(response.json().statusCode, 400);
    assert.equal(response.json().error, 'Bad Request');
  }

  assert.equal(await app.prisma.measurement.count({ where: { deviceId } }), 0);
});

test('POST /measurements returns 422 for a nonexistent device', async (t) => {
  const { app } = await setup(t);
  const missingDeviceId = randomUUID();

  const response = await app.inject({
    method: 'POST',
    url: '/measurements',
    payload: {
      deviceId: missingDeviceId,
      eco2: 450,
      tvoc: 12,
      measuredAt: '2026-01-01T12:00:00.000Z',
    },
  });

  assert.equal(response.statusCode, 422, response.body);
  assert.deepEqual(response.json(), {
    statusCode: 422,
    error: 'Unprocessable Entity',
    message: 'Measurement device does not exist',
  });
  assert.doesNotMatch(response.body, /Prisma|P2003|foreign key|stack/i);
  assert.equal(
    await app.prisma.measurement.count({
      where: { deviceId: missingDeviceId },
    }),
    0,
  );
});

test('POST /measurements returns 409 for a duplicate device and time', async (t) => {
  const { app, deviceId, otherDeviceId } = await setup(t);
  const payload = {
    deviceId,
    eco2: 450,
    tvoc: 12,
    measuredAt: '2026-01-01T12:00:00.000Z',
  };

  const first = await app.inject({
    method: 'POST',
    url: '/measurements',
    payload,
  });
  assert.equal(first.statusCode, 201, first.body);

  // Same instant expressed with a different offset is still a duplicate.
  const duplicate = await app.inject({
    method: 'POST',
    url: '/measurements',
    payload: { ...payload, eco2: 999, measuredAt: '2026-01-01T13:00:00+01:00' },
  });

  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.deepEqual(duplicate.json(), {
    statusCode: 409,
    error: 'Conflict',
    message: 'Measurement for this device and time already exists',
  });
  assert.doesNotMatch(duplicate.body, /Prisma|P2002|unique|stack/i);

  const saved = await app.prisma.measurement.findMany({ where: { deviceId } });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].eco2, 450);

  const otherDevice = await app.inject({
    method: 'POST',
    url: '/measurements',
    payload: { ...payload, deviceId: otherDeviceId },
  });
  assert.equal(otherDevice.statusCode, 201, otherDevice.body);
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

test('POST /measurements is still accepted without a token until device keys exist', async (t) => {
  const { app, deviceId } = await setup(t);

  const response = await app.inject({
    method: 'POST',
    url: '/measurements',
    payload: {
      deviceId,
      eco2: 450,
      tvoc: 12,
      measuredAt: '2026-01-01T12:00:00.000Z',
    },
  });

  assert.equal(response.statusCode, 201, response.body);
});

for (const { method, stage } of [
  { method: 'POST', stage: 'measurement create' },
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
        create: fail,
        findFirst: fail,
        findMany: async () => [],
        count: async () => 0,
      },
      $transaction: fail,
    } as unknown as PrismaClient);
    app.decorateRequest('user', null);
    app.decorate('authenticate', async (request: FastifyRequest) => {
      request.user = {
        id: randomUUID(),
        keycloakSubject: randomUUID(),
        email: 'stub@test.cz',
      };
    });
    await app.register(measurementRoutes, { prefix: '/measurements' });

    const response = await app.inject(
      method === 'POST'
        ? {
            method,
            url: '/measurements',
            payload: {
              deviceId,
              eco2: 450,
              tvoc: 12,
              measuredAt: '2026-01-01T12:00:00.000Z',
            },
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
