import { ZodTypeProvider } from '@fastify/type-provider-zod';
import { FastifyPluginAsync } from 'fastify';
import { authErrorResponses } from '../../schemas/common.schema';
import { meResponseSchema } from '../../schemas/me.schema';
import { requireUser } from '../../plugins/auth';

const me: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      prefixTrailingSlash: 'no-slash',
      onRequest: [app.authenticate],
      schema: {
        tags: ['Me'],
        summary: 'Current user',
        response: {
          200: meResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => {
      const user = requireUser(request);
      return { id: user.id, email: user.email };
    },
  );
};

export default me;
