import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import type {} from '@fastify/sensible';
import type {} from './prisma';
import { API_PREFIX_KEY, hashApiKey } from '../utils/api-key';

export interface AuthDevice {
  id: string;
  ownerId: string;
}

export const requireDevice = (request: FastifyRequest): AuthDevice => {
  if (!request.device)
    throw new Error(
      'requireDevice() called on a route without authenticateDevice',
    );
  return request.device;
};

export default fp(
  async (fastify) => {
    const authenticateDevice = async (
      request: FastifyRequest,
    ): Promise<void> => {
      const header = request.headers.authorization;
      if (!header?.startsWith('Bearer '))
        throw fastify.httpErrors.unauthorized('Missing device key');

      const key = header.slice('Bearer '.length);
      if (!key.startsWith(API_PREFIX_KEY))
        throw fastify.httpErrors.unauthorized('Invalid device key');

      const [device] = await fastify.prisma.device.updateManyAndReturn({
        where: { apiKeyHash: hashApiKey(key) },
        data: { lastSeenAt: new Date() },
        select: { id: true, ownerId: true },
      });
      if (!device) throw fastify.httpErrors.unauthorized('Invalid device key');

      request.device = device;
    };
    fastify.decorateRequest('device', null);
    fastify.decorate('authenticateDevice', authenticateDevice);
  },
  { name: 'device-auth', dependencies: ['prisma'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    authenticateDevice: (request: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    device: AuthDevice | null;
  }
}
