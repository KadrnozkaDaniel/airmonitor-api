import fp from 'fastify-plugin';
import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { FastifyRequest } from 'fastify';
import { Prisma } from '../../prisma/generated/client';
import 'dotenv/config';
import type {} from '@fastify/sensible';
import type {} from './prisma';

export interface AuthUser {
  id: string;
  keycloakSubject: string;
  email: string;
}

export interface AuthPluginOptions {
  authJwks?: JWTVerifyGetKey;
}

export const requireUser = (request: FastifyRequest): AuthUser => {
  if (!request.user)
    throw new Error('requireUser() called on a route without authenticate');

  return request.user;
};

const isUniqueViolationOn = (e: unknown, field: string) => {
  if (
    !(e instanceof Prisma.PrismaClientKnownRequestError) ||
    e.code !== 'P2002'
  )
    return false;

  const target = e.meta?.target;
  if (Array.isArray(target) && target.includes(field)) return true;

  const constraint = (
    e.meta?.driverAdapterError as
      | { cause?: { constraint?: { index?: string; fields?: string[] } } }
      | undefined
  )?.cause?.constraint;

  return (
    constraint?.fields?.includes(field) === true ||
    constraint?.index?.includes(`_${field}_`) === true
  );
};

export default fp<AuthPluginOptions>(
  async (fastify, opts) => {
    const issuer = process.env.KEYCLOAK_ISSUER;
    const audience = process.env.KEYCLOAK_AUDIENCE;

    if (!issuer || !audience)
      throw new Error('KEYCLOAK_ISSUER or KEYCLOAK_AUDIENCE is missing');

    const jwks =
      opts.authJwks ??
      createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));

    const emailConflict = () =>
      fastify.httpErrors.conflict(
        'A user with this email already exists under a different identity',
      );

    const findOrCreateUser = async (payload: JWTPayload): Promise<AuthUser> => {
      const { sub, email } = payload;
      if (typeof sub !== 'string' || typeof email !== 'string')
        throw fastify.httpErrors.unauthorized(
          'Token is missing required claims',
        );

      let user = await fastify.prisma.user.findUnique({
        where: { keycloakSubject: sub },
      });

      if (!user) {
        try {
          user = await fastify.prisma.user.create({
            data: { keycloakSubject: sub, email },
          });
        } catch (e) {
          if (
            !(e instanceof Prisma.PrismaClientKnownRequestError) ||
            e.code !== 'P2002'
          )
            throw e;

          user = await fastify.prisma.user.findUnique({
            where: { keycloakSubject: sub },
          });

          if (!user) {
            if (isUniqueViolationOn(e, 'email')) throw emailConflict();
            throw e;
          }
        }
      }

      if (user.email !== email) {
        try {
          user = await fastify.prisma.user.update({
            where: { id: user.id },
            data: { email },
          });
        } catch (e) {
          if (isUniqueViolationOn(e, 'email')) throw emailConflict();
          throw e;
        }
      }

      return { id: user.id, keycloakSubject: sub, email: user.email };
    };

    const authenticate = async (request: FastifyRequest): Promise<void> => {
      const header = request.headers.authorization;
      if (!header?.startsWith('Bearer '))
        throw fastify.httpErrors.unauthorized('Missing bearer token');

      const token = header.slice('Bearer '.length);

      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer,
          audience,
          algorithms: ['RS256'],
        }));
      } catch (err) {
        if (err instanceof errors.JWKSTimeout) {
          request.log.error({ err }, 'Keycloak JWKS request timed out');
          throw fastify.httpErrors.serviceUnavailable(
            'Authentication service unavailable',
          );
        }

        if (err instanceof errors.JOSEError) {
          request.log.debug({ err }, 'JWT verification failed');
          throw fastify.httpErrors.unauthorized('Invalid token');
        }

        request.log.error({ err }, 'Could not verify JWT');
        throw fastify.httpErrors.serviceUnavailable(
          'Authentication service unavailable',
        );
      }

      request.user = await findOrCreateUser(payload);
    };

    fastify.decorateRequest('user', null);
    fastify.decorate('authenticate', authenticate);
  },
  { name: 'auth', dependencies: ['prisma'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    user: AuthUser | null;
  }
}
