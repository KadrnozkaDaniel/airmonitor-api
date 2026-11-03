import { FastifyPluginAsync } from 'fastify';
import { healthResponseSchema } from '../schemas/health.schema';
import { ZodTypeProvider } from '@fastify/type-provider-zod';

const root: FastifyPluginAsync = async (fastify): Promise<void> => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Check API health',
        description: 'Get API health',

        response: {
          200: healthResponseSchema,
        },
      },
    },
    () => ({ status: 'ok' as const }),
  );
};

export default root;
