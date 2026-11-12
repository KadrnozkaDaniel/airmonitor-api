import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import appPlugin from '../../../src/app';
import type {} from '../../../src/plugins/prisma';
import { createTestAuth, newIdentity, type TestIdentity } from '../../auth';

async function setup(t: TestContext) {
  const app = Fastify();
  const auth = await createTestAuth();
  const subjects: string[] = [];

  t.after(async () => {
    try {
      if (app.hasDecorator('prisma')) {
        await app.prisma.user.deleteMany({
          where: { keycloakSubject: { in: subjects } },
        });
      }
    } finally {
      await app.close();
    }
  });

  await app.register(fp(appPlugin), { authJwks: auth.jwks });
  await app.ready();

  const identity = (label?: string): TestIdentity => {
    const created = newIdentity(label);
    subjects.push(created.sub);
    return created;
  };

  const getMe = async (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/me', headers });

  return { app, ...auth, identity, getMe };
}

test('GET /me returns 401 without a bearer token', async (t) => {
  const { getMe } = await setup(t);

  for (const headers of [
    {} as Record<string, string>,
    { authorization: 'Basic dXNlcjpwYXNz' },
    { authorization: 'Bearer' },
  ]) {
    const response = await getMe(headers);
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(response.json().statusCode, 401);
  }
});

test('GET /me provisions the user on first request and reuses it afterwards', async (t) => {
  const { app, identity, authHeader, getMe } = await setup(t);
  const karel = identity('karel');
  const headers = await authHeader(karel);

  const first = await getMe(headers);
  assert.equal(first.statusCode, 200, first.body);
  const body = first.json();
  assert.equal(body.email, karel.email);
  assert.deepEqual(Object.keys(body).sort(), ['email', 'id']);

  const saved = await app.prisma.user.findUniqueOrThrow({
    where: { keycloakSubject: karel.sub },
  });
  assert.equal(saved.id, body.id);
  assert.equal(saved.email, karel.email);

  const second = await getMe(headers);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().id, body.id);
  assert.equal(
    await app.prisma.user.count({ where: { keycloakSubject: karel.sub } }),
    1,
  );
});

test('GET /me provisions only one user for concurrent first requests', async (t) => {
  const { app, identity, authHeader, getMe } = await setup(t);
  const karel = identity('karel');
  const headers = await authHeader(karel);

  const responses = await Promise.all(
    Array.from({ length: 5 }, () => getMe(headers)),
  );

  for (const response of responses) {
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.equal(new Set(responses.map((r) => r.json().id)).size, 1);
  assert.equal(
    await app.prisma.user.count({ where: { keycloakSubject: karel.sub } }),
    1,
  );
});

test('GET /me rejects tokens that fail verification', async (t) => {
  const { app, identity, authHeader, getMe } = await setup(t);
  const karel = identity('karel');
  const foreignAuth = await createTestAuth();

  const cases: [string, Record<string, string>][] = [
    ['wrong audience', await authHeader(karel, { audience: 'other-client' })],
    ['wrong issuer', await authHeader(karel, { issuer: 'http://evil.test' })],
    [
      'expired',
      await authHeader(karel, { exp: Math.floor(Date.now() / 1000) - 60 }),
    ],
    ['signed by another key', await foreignAuth.authHeader(karel)],
    [
      'tampered',
      { authorization: `${(await authHeader(karel)).authorization}x` },
    ],
    ['malformed', { authorization: 'Bearer not-a-jwt' }],
    ['missing email claim', await authHeader(karel, { omitEmail: true })],
  ];

  for (const [label, headers] of cases) {
    const response = await getMe(headers);
    assert.equal(response.statusCode, 401, `${label}: ${response.body}`);
    assert.doesNotMatch(
      response.body,
      /\b(exp|aud|iss|kid|alg)\b|signature|expired|jose|JWS/i,
      label,
    );
  }

  assert.equal(
    await app.prisma.user.count({ where: { keycloakSubject: karel.sub } }),
    0,
  );
});

test('GET /me updates the stored email when it changes in Keycloak', async (t) => {
  const { app, identity, authHeader, getMe } = await setup(t);
  const karel = identity('karel');

  const first = await getMe(await authHeader(karel));
  assert.equal(first.statusCode, 200, first.body);

  const newEmail = `renamed-${karel.sub}@test.cz`;
  const second = await getMe(await authHeader(karel, { email: newEmail }));
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().id, first.json().id);
  assert.equal(second.json().email, newEmail);

  const saved = await app.prisma.user.findUniqueOrThrow({
    where: { keycloakSubject: karel.sub },
  });
  assert.equal(saved.email, newEmail);
});

test('GET /me returns 409 when another identity already owns the email', async (t) => {
  const { app, identity, authHeader, getMe } = await setup(t);
  const karel = identity('karel');
  const impostor = { ...identity('impostor'), email: karel.email };

  assert.equal((await getMe(await authHeader(karel))).statusCode, 200);

  const created = await getMe(await authHeader(impostor));
  assert.equal(created.statusCode, 409, created.body);
  assert.equal(
    await app.prisma.user.count({ where: { keycloakSubject: impostor.sub } }),
    0,
  );

  const jan = identity('jan');
  assert.equal((await getMe(await authHeader(jan))).statusCode, 200);
  const updated = await getMe(await authHeader(jan, { email: karel.email }));
  assert.equal(updated.statusCode, 409, updated.body);
});
