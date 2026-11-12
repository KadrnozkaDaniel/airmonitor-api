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
import deviceRoutes from '../../../src/routes/devices';
import type { DeviceResponse } from '../../../src/schemas/device.schema';
import { createTestAuth, newIdentity } from '../../auth';

async function setup(t: TestContext) {
  const app = Fastify();
  const auth = await createTestAuth();
  const karel = { id: randomUUID(), ...newIdentity('karel') };
  const jan = { id: randomUUID(), ...newIdentity('jan') };
  const userIds = [karel.id, jan.id];

  t.after(async () => {
    try {
      if (app.hasDecorator('prisma')) {
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

  return {
    app,
    karel: { ...karel, headers: await auth.authHeader(karel) },
    jan: { ...jan, headers: await auth.authHeader(jan) },
  };
}

test('/devices routes return 401 without a valid token', async (t) => {
  const { app, karel } = await setup(t);
  const [device] = await app.prisma.device.createManyAndReturn({
    data: [{ name: 'Kitchen', ownerId: karel.id }],
  });

  for (const headers of [{}, { authorization: 'Bearer not-a-jwt' }]) {
    for (const request of [
      { method: 'POST', url: '/devices', payload: { name: 'Kitchen' } },
      { method: 'GET', url: '/devices' },
      { method: 'GET', url: `/devices/${device.id}` },
    ] as const) {
      const response = await app.inject({ ...request, headers });
      assert.equal(
        response.statusCode,
        401,
        `${request.method} ${request.url}: ${response.body}`,
      );
    }
  }

  assert.equal(
    await app.prisma.device.count({ where: { ownerId: karel.id } }),
    1,
  );
});

test('POST /devices persists a device and GET returns the saved data', async (t) => {
  const { app, karel } = await setup(t);

  const response = await app.inject({
    method: 'POST',
    url: '/devices',
    headers: karel.headers,
    payload: {
      name: 'Test name  ',
      description: 'Test description  ',
    },
  });

  assert.equal(response.statusCode, 201, response.body);
  assert.match(response.headers['content-type'] ?? '', /application\/json/);
  const body = response.json<DeviceResponse>();
  assert.deepEqual(Object.keys(body).sort(), [
    'createdAt',
    'description',
    'id',
    'name',
    'ownerId',
  ]);
  assert.match(body.id, /^[0-9a-f-]{36}$/i);
  assert.equal(body.name, 'Test name');
  assert.equal(body.description, 'Test description');
  assert.equal(body.ownerId, karel.id);
  assert.equal(new Date(body.createdAt).toISOString(), body.createdAt);

  const saved = await app.prisma.device.findUniqueOrThrow({
    where: { id: body.id },
  });
  assert.deepEqual(body, {
    ...saved,
    createdAt: saved.createdAt.toISOString(),
  });

  const list = await app.inject({
    method: 'GET',
    url: '/devices',
    headers: karel.headers,
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(list.json(), {
    data: [body],
    pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
  });
});

test('POST /devices accepts omitted/null descriptions and duplicate names', async (t) => {
  const { app, karel } = await setup(t);

  for (const description of [undefined, null]) {
    const response = await app.inject({
      method: 'POST',
      url: '/devices',
      headers: karel.headers,
      payload: { name: 'Bedroom', description },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().description, null);
  }

  const saved = await app.prisma.device.findMany({
    where: { ownerId: karel.id },
  });
  assert.equal(saved.length, 2);
  assert.ok(saved.every((device) => device.description === null));
});

test('POST /devices accepts names and descriptions at their length limits', async (t) => {
  const { app, karel } = await setup(t);
  const payload = {
    name: 'x'.repeat(100),
    description: 'x'.repeat(1000),
  };

  const response = await app.inject({
    method: 'POST',
    url: '/devices',
    headers: karel.headers,
    payload,
  });

  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().name, payload.name);
  assert.equal(response.json().description, payload.description);
});

test('POST /devices rejects invalid bodies without writing to the database', async (t) => {
  const { app, karel } = await setup(t);
  const valid = { name: 'Kitchen' };
  const invalidBodies = [
    {},
    { ...valid, name: '' },
    { ...valid, name: '   ' },
    { ...valid, name: null },
    { ...valid, name: 123 },
    { ...valid, name: 'x'.repeat(101) },
    { ...valid, description: 'x'.repeat(1001) },
    { ...valid, description: 123 },
    { ...valid, id: randomUUID() },
    { ...valid, createdAt: new Date().toISOString() },
  ];

  for (const payload of invalidBodies) {
    const response = await app.inject({
      method: 'POST',
      url: '/devices',
      headers: karel.headers,
      payload,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().statusCode, 400);
  }

  assert.equal(
    await app.prisma.device.count({ where: { ownerId: karel.id } }),
    0,
  );
});

test('POST /devices rejects an ownerId in the body instead of trusting it', async (t) => {
  const { app, karel, jan } = await setup(t);

  const response = await app.inject({
    method: 'POST',
    url: '/devices',
    headers: karel.headers,
    payload: { name: 'Kitchen', ownerId: jan.id },
  });

  assert.equal(response.statusCode, 400, response.body);
  assert.equal(
    await app.prisma.device.count({
      where: { ownerId: { in: [karel.id, jan.id] } },
    }),
    0,
  );
});

test('GET /devices/:id returns the requested device with a serialized date', async (t) => {
  const { app, karel } = await setup(t);
  const device = {
    id: randomUUID(),
    name: 'Living room',
    description: 'Near the window',
    ownerId: karel.id,
    createdAt: new Date('2026-01-01T12:00:00.000Z'),
  };
  await app.prisma.device.create({ data: device });

  const response = await app.inject({
    method: 'GET',
    url: `/devices/${device.id}`,
    headers: karel.headers,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.headers['content-type'] ?? '', /application\/json/);
  assert.deepEqual(response.json(), {
    ...device,
    createdAt: device.createdAt.toISOString(),
  });
});

test('GET /devices/:id returns 404 for a nonexistent device', async (t) => {
  const { app, karel } = await setup(t);

  const response = await app.inject({
    method: 'GET',
    url: `/devices/${randomUUID()}`,
    headers: karel.headers,
  });

  assert.equal(response.statusCode, 404, response.body);
  assert.deepEqual(response.json(), {
    statusCode: 404,
    error: 'Not Found',
    message: 'Device does not exist',
  });
});

test("GET /devices/:id returns 404 for another user's device", async (t) => {
  const { app, karel, jan } = await setup(t);
  const [jansDevice] = await app.prisma.device.createManyAndReturn({
    data: [{ name: "Jan's bedroom", ownerId: jan.id }],
  });

  const response = await app.inject({
    method: 'GET',
    url: `/devices/${jansDevice.id}`,
    headers: karel.headers,
  });

  assert.equal(response.statusCode, 404, response.body);
  assert.deepEqual(response.json(), {
    statusCode: 404,
    error: 'Not Found',
    message: 'Device does not exist',
  });

  const own = await app.inject({
    method: 'GET',
    url: `/devices/${jansDevice.id}`,
    headers: jan.headers,
  });
  assert.equal(own.statusCode, 200, own.body);
});

test('GET /devices/:id rejects invalid UUIDs', async (t) => {
  const { app, karel } = await setup(t);
  const invalidIds = [
    'invalid-uuid',
    '123',
    'gggggggg-gggg-4ggg-8ggg-gggggggggggg',
  ];

  for (const id of invalidIds) {
    const response = await app.inject({
      method: 'GET',
      url: `/devices/${id}`,
      headers: karel.headers,
    });

    assert.equal(response.statusCode, 400, `${id}: ${response.body}`);
    assert.equal(response.json().statusCode, 400);
    assert.equal(response.json().error, 'Bad Request');
    assert.doesNotMatch(response.body, /Prisma|P2023|stack/i);
  }
});

test('GET /devices lists only own devices and paginates in deterministic order', async (t) => {
  const { app, karel, jan } = await setup(t);
  const tiedIds = [randomUUID(), randomUUID()].sort().reverse();
  const newestId = randomUUID();
  await app.prisma.device.createMany({
    data: [
      ...tiedIds.map((id) => ({
        id,
        name: 'Tied device',
        ownerId: karel.id,
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
      })),
      {
        id: newestId,
        name: 'Newest device',
        ownerId: karel.id,
        createdAt: new Date('2026-01-02T12:00:00.000Z'),
      },
      {
        name: "Jan's device",
        ownerId: jan.id,
        createdAt: new Date('2026-01-03T12:00:00.000Z'),
      },
    ],
  });

  for (const [page, expectedIds] of [
    [1, [newestId, tiedIds[0]]],
    [2, [tiedIds[1]]],
    [3, []],
  ] as const) {
    const response = await app.inject({
      method: 'GET',
      url: `/devices?page=${page}&limit=2`,
      headers: karel.headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    const { data, pagination } = response.json();
    assert.deepEqual(
      data.map((device: DeviceResponse) => device.id),
      expectedIds,
    );
    assert.deepEqual(pagination, { page, limit: 2, total: 3, totalPages: 2 });
  }

  const jansList = await app.inject({
    method: 'GET',
    url: '/devices',
    headers: jan.headers,
  });
  assert.equal(jansList.statusCode, 200, jansList.body);
  assert.deepEqual(
    jansList.json().data.map((device: DeviceResponse) => device.ownerId),
    [jan.id],
  );
});

test('GET /devices returns 200 and an empty list when the user has no devices', async (t) => {
  const { app, karel, jan } = await setup(t);
  await app.prisma.device.create({
    data: { name: "Jan's device", ownerId: jan.id },
  });

  const response = await app.inject({
    method: 'GET',
    url: '/devices',
    headers: karel.headers,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    data: [],
    pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
  });
});

test('GET /devices limits results to the default page size', async (t) => {
  const { app, karel } = await setup(t);
  await app.prisma.device.createMany({
    data: Array.from({ length: 11 }, (_, index) => ({
      name: `Device ${index}`,
      ownerId: karel.id,
    })),
  });

  const response = await app.inject({
    method: 'GET',
    url: '/devices',
    headers: karel.headers,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.length, 10);
  assert.deepEqual(response.json().pagination, {
    page: 1,
    limit: 10,
    total: 11,
    totalPages: 2,
  });
});

test('GET /devices rejects invalid and unknown query parameters', async (t) => {
  const { app, karel, jan } = await setup(t);
  const invalidQueries = [
    `ownerId=${jan.id}`,
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
  ];

  for (const query of invalidQueries) {
    const response = await app.inject({
      method: 'GET',
      url: `/devices?${query}`,
      headers: karel.headers,
    });
    assert.equal(response.statusCode, 400, `${query}: ${response.body}`);
  }
});

for (const { method, url } of [
  { method: 'POST', url: '/devices' },
  { method: 'GET', url: '/devices' },
  { method: 'GET', url: `/devices/${randomUUID()}` },
] as const) {
  test(`${method} ${url} hides unexpected database errors`, async (t) => {
    const app = Fastify();
    t.after(() => app.close());
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const fail = async () => {
      throw new Error('Sensitive database connection details');
    };
    app.decorate('prisma', {
      device: {
        create: fail,
        findUnique: fail,
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

    await app.register(deviceRoutes, { prefix: '/devices' });

    const response = await app.inject({
      method,
      url,
      ...(method === 'POST' ? { payload: { name: 'Kitchen' } } : {}),
    });

    assert.equal(response.statusCode, 500, response.body);
    assert.deepEqual(response.json(), {
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    });
  });
}
