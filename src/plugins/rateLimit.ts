import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';

export const RATE_LIMITS = {
  global: { max: 100, timeWindow: '1 minute' },
  deviceIngest: { max: 30, timeWindow: '1 minute' },
  apiKeyRotation: { max: 5, timeWindow: '1 minute' },
} as const;

export default fp(
  async (fastify) => {
    await fastify.register(rateLimit, RATE_LIMITS.global);
  },
  { name: 'rate-limit' },
);
