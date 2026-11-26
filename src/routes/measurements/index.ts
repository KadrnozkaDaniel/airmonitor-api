import { ZodTypeProvider } from '@fastify/type-provider-zod';
import { FastifyPluginAsync } from 'fastify';
import { DeviceNotFoundError } from '../../services/device.service';
import {
  ingestMeasurements,
  latestMeasurement,
  listMeasurements,
  MeasurementNotFoundError,
} from '../../services/measurement.service';
import {
  authErrorResponses,
  errorResponseSchema,
} from '../../schemas/common.schema';
import {
  ingestMeasurementsBodySchema,
  ingestMeasurementsResponseSchema,
  latestMeasurementQuerySchema,
  listMeasurementsQuerySchema,
  listMeasurementsResponseSchema,
  measurementResponseSchema,
} from '../../schemas/measurement.schema';
import { requireUser } from '../../plugins/auth';
import { requireDevice } from '../../plugins/deviceAuth';
import { RATE_LIMITS } from '../../plugins/rateLimit';

const measurements: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.setErrorHandler((error, request, reply) => {
    if (
      error instanceof DeviceNotFoundError ||
      error instanceof MeasurementNotFoundError
    ) {
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
      ((error.statusCode >= 400 && error.statusCode < 500) ||
        error.statusCode === 503)
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

  app.post(
    '/',
    {
      prefixTrailingSlash: 'no-slash',
      onRequest: [
        app.rateLimit(RATE_LIMITS.deviceIngest),
        app.authenticateDevice,
      ],
      bodyLimit: 256 * 1024,
      schema: {
        tags: ['Measurements'],
        summary: 'Ingest measurements',
        description:
          'Stores a batch of measurements for the device identified by its API key. Duplicates are skipped',
        body: ingestMeasurementsBodySchema,
        response: {
          200: ingestMeasurementsResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          429: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const device = requireDevice(request);

      return ingestMeasurements(app.prisma, device.id, request.body);
    },
  );

  app.get(
    '/',
    {
      prefixTrailingSlash: 'no-slash',
      onRequest: [app.authenticate],
      schema: {
        tags: ['Measurements'],
        summary: 'Get measurements',
        description: 'Returns measurements of one of your devices',
        querystring: listMeasurementsQuerySchema,

        response: {
          200: listMeasurementsResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => {
      const user = requireUser(request);
      return listMeasurements(app.prisma, user.id, request.query);
    },
  );

  app.get(
    '/latest',
    {
      prefixTrailingSlash: 'no-slash',
      onRequest: [app.authenticate],
      schema: {
        tags: ['Measurements'],
        summary: 'Get latest measurement',
        description: 'Returns the latest measurement of a device',
        querystring: latestMeasurementQuerySchema,
        response: {
          200: measurementResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => {
      const user = requireUser(request);
      return latestMeasurement(app.prisma, user.id, request.query);
    },
  );
};

export default measurements;
