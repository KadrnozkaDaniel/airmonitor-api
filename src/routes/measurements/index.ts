import { FastifyPluginAsync } from 'fastify';
import {
  listMeasurementsQuerySchema,
  listMeasurementsResponseSchema,
  measurementErrorResponseSchema,
} from '../../schemas/measurement.schema';
import { ZodTypeProvider } from '@fastify/type-provider-zod';
import { listMeasurements } from '../../services/measurement.service';
import { DeviceNotFoundError } from '../../services/device.service';

const measurement: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DeviceNotFoundError) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: error.message,
      });
    }

    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply.send(error);
    }

    request.log.error({ err: error }, 'Measurement request failed');

    return reply.code(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    });
  });

  app.get(
    '/',
    {
      prefixTrailingSlash: 'no-slash',
      schema: {
        tags: ['Measurements'],
        summary: 'Get measurements',
        description: 'Returns a list of measurements',
        querystring: listMeasurementsQuerySchema,
        response: {
          200: listMeasurementsResponseSchema,
          400: measurementErrorResponseSchema,
          404: measurementErrorResponseSchema,
          500: measurementErrorResponseSchema,
        },
      },
    },
    async (request) => {
      return listMeasurements(app.prisma, request.query);
    },
  );
};

export default measurement;
