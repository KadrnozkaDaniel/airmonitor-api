import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import {
  serializerCompiler,
  validatorCompiler,
} from '@fastify/type-provider-zod';
import type { PrismaClient } from '../../../prisma/generated/client';
import appPlugin from '../../../src/app';
import type {} from '../../../src/plugins/prisma';
import deviceRoutes from '../../../src/routes/devices';
import type { DeviceResponse } from '../../../src/schemas/device.schema';

async function setup(t: TestContext) {
  const app = Fastify();
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const ownerIds = [ownerId, otherOwnerId];

  t.after(async () => {
    try {
      if (app.hasDecorator('prisma')) {
        await app.prisma.device.deleteMany({
          where: { ownerId: { in: ownerIds } },
        });
        await app.prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
      }
    } finally {
      await app.close();
    }
  });

  await app.register(fp(appPlugin));
  await app.ready();
  await app.prisma.user.createMany({
    data: ownerIds.map((id) => ({
      id,
      email: `test-${id}@test.cz`,
    })),
  });

  return { app, ownerId, otherOwnerId };
}

test('POST /devices persists a device and GET returns the saved data', async (t) => {
  const { app, ownerId } = await setup(t);

  const response = await app.inject({
    method: 'POST',
    url: '/devices',
    payload: {
      name: 'Test name  ',
      description: 'Test description  ',
      ownerId,
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
  assert.equal(body.ownerId, ownerId);
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
    url: `/devices?ownerId=${ownerId}`,
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(list.json(), {
    data: [body],
    pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
  });
});

test('POST /devices accepts omitted/null descriptions and duplicate names', async (t) => {
  const { app, ownerId } = await setup(t);

  for (const description of [undefined, null]) {
    const response = await app.inject({
      method: 'POST',
      url: '/devices',
      payload: { name: 'Bedroom', description, ownerId },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().description, null);
  }

  const saved = await app.prisma.device.findMany({ where: { ownerId } });
  assert.equal(saved.length, 2);
  assert.ok(saved.every((device) => device.description === null));
});

test('POST /devices accepts names and descriptions at their length limits', async (t) => {
  const { app, ownerId } = await setup(t);
  const payload = {
    name: 'x'.repeat(100),
    description: 'x'.repeat(1000),
    ownerId,
  };

  const response = await app.inject({
    method: 'POST',
    url: '/devices',
    payload,
  });

  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().name, payload.name);
  assert.equal(response.json().description, payload.description);
});

test('POST /devices rejects invalid bodies without writing to the database', async (t) => {
  const { app, ownerId } = await setup(t);
  const valid = { name: 'Kitchen', ownerId };
  const invalidBodies = [
    {},
    { ownerId },
    { name: 'Kitchen' },
    { ...valid, name: '' },
    { ...valid, name: '   ' },
    { ...valid, name: null },
    { ...valid, name: 123 },
    { ...valid, name: 'x'.repeat(101) },
    { ...valid, description: 'x'.repeat(1001) },
    { ...valid, description: 123 },
    { ...valid, ownerId: 'invalid-uuid' },
    { ...valid, id: randomUUID() },
    { ...valid, createdAt: new Date().toISOString() },
  ];

  for (const payload of invalidBodies) {
    const response = await app.inject({
      method: 'POST',
      url: '/devices',
      payload,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().statusCode, 400);
  }

  assert.equal(await app.prisma.device.count({ where: { ownerId } }), 0);
});

test('POST /devices returns 422 for a nonexistent owner', async (t) => {
  const { app } = await setup(t);
  const missingOwnerId = randomUUID();

  const response = await app.inject({
    method: 'POST',
    url: '/devices',
    payload: { name: 'Kitchen', ownerId: missingOwnerId },
  });

  assert.equal(response.statusCode, 422, response.body);
  const body = response.json();
  assert.equal(body.statusCode, 422);
  assert.equal(body.error, 'Unprocessable Entity');
  assert.equal(typeof body.message, 'string');
  assert.doesNotMatch(response.body, /Prisma|P2003|foreign key|stack/i);
  assert.equal(
    await app.prisma.device.count({ where: { ownerId: missingOwnerId } }),
    0,
  );
});

test('GET /devices/:id returns the requested device with a serialized date', async (t) => {
  const { app, ownerId, otherOwnerId } = await setup(t);
  const devices = [
    {
      id: randomUUID(),
      name: 'Living room',
      description: 'Near the window',
      ownerId,
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
    },
    {
      id: randomUUID(),
      name: 'Bedroom',
      description: null,
      ownerId: otherOwnerId,
      createdAt: new Date('2026-01-02T12:00:00.000Z'),
    },
  ];
  await app.prisma.device.createMany({ data: devices });

  for (const device of devices) {
    const response = await app.inject({
      method: 'GET',
      url: `/devices/${device.id}`,
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.headers['content-type'] ?? '', /application\/json/);
    assert.deepEqual(response.json(), {
      ...device,
      createdAt: device.createdAt.toISOString(),
    });
  }
});

test('GET /devices/:id returns 404 for a nonexistent device', async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({
    method: 'GET',
    url: `/devices/${randomUUID()}`,
  });

  assert.equal(response.statusCode, 404, response.body);
  assert.deepEqual(response.json(), {
    statusCode: 404,
    error: 'Not Found',
    message: 'Device does not exist',
  });
});

test('GET /devices/:id rejects invalid UUIDs', async (t) => {
  const { app } = await setup(t);
  const invalidIds = [
    'invalid-uuid',
    '123',
    'gggggggg-gggg-4ggg-8ggg-gggggggggggg',
  ];

  for (const id of invalidIds) {
    const response = await app.inject({
      method: 'GET',
      url: `/devices/${id}`,
    });

    assert.equal(response.statusCode, 400, `${id}: ${response.body}`);
    assert.equal(response.json().statusCode, 400);
    assert.equal(response.json().error, 'Bad Request');
    assert.doesNotMatch(response.body, /Prisma|P2023|stack/i);
  }
});

test('GET /devices filters owners and paginates in deterministic order', async (t) => {
  const { app, ownerId, otherOwnerId } = await setup(t);
  const tiedIds = [randomUUID(), randomUUID()].sort().reverse();
  const newestId = randomUUID();
  await app.prisma.device.createMany({
    data: [
      ...tiedIds.map((id) => ({
        id,
        name: 'Tied device',
        ownerId,
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
      })),
      {
        id: newestId,
        name: 'Newest device',
        ownerId,
        createdAt: new Date('2026-01-02T12:00:00.000Z'),
      },
      { name: 'Other owner device', ownerId: otherOwnerId },
    ],
  });

  for (const [page, expectedIds] of [
    [1, [newestId, tiedIds[0]]],
    [2, [tiedIds[1]]],
    [3, []],
  ] as const) {
    const response = await app.inject({
      method: 'GET',
      url: `/devices?ownerId=${ownerId}&page=${page}&limit=2`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const { data, pagination } = response.json();
    assert.deepEqual(
      data.map((device: DeviceResponse) => device.id),
      expectedIds,
    );
    assert.ok(
      data.every((device: DeviceResponse) => device.ownerId === ownerId),
    );
    assert.deepEqual(pagination, { page, limit: 2, total: 3, totalPages: 2 });
  }
});

test('GET /devices returns 200 and an empty list when no devices match', async (t) => {
  const { app, ownerId } = await setup(t);
  const response = await app.inject({
    method: 'GET',
    url: `/devices?ownerId=${ownerId}`,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    data: [],
    pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
  });
});

test('GET /devices limits results to the default page size', async (t) => {
  const { app, ownerId } = await setup(t);
  await app.prisma.device.createMany({
    data: Array.from({ length: 11 }, (_, index) => ({
      name: `Device ${index}`,
      ownerId,
    })),
  });

  const response = await app.inject({
    method: 'GET',
    url: `/devices?ownerId=${ownerId}`,
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

test('GET /devices supports listing without an owner filter', async (t) => {
  const { app } = await setup(t);
  const response = await app.inject({ method: 'GET', url: '/devices' });

  assert.equal(response.statusCode, 200, response.body);
  const { data, pagination } = response.json();
  assert.equal(pagination.page, 1);
  assert.equal(pagination.limit, 10);
  assert.equal(data.length, Math.min(pagination.total, 10));
  assert.equal(pagination.totalPages, Math.ceil(pagination.total / 10));
});

test('GET /devices rejects invalid and unknown query parameters', async (t) => {
  const { app } = await setup(t);
  const invalidQueries = [
    'ownerId=invalid-uuid',
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
    await app.register(deviceRoutes, { prefix: '/devices' });

    const response = await app.inject({
      method,
      url,
      ...(method === 'POST'
        ? { payload: { name: 'Kitchen', ownerId: randomUUID() } }
        : {}),
    });

    assert.equal(response.statusCode, 500, response.body);
    assert.deepEqual(response.json(), {
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    });
  });
}
