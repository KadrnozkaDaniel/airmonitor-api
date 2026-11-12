import { ZodTypeProvider } from '@fastify/type-provider-zod';
import { FastifyPluginAsync } from 'fastify';
import { DeviceNotFoundError } from '../../services/device.service';
import {
  addMeasurement,
  DuplicateMeasurementError,
  latestMeasurement,
  listMeasurements,
  MeasurementDeviceNotFoundError,
  MeasurementNotFoundError,
} from '../../services/measurement.service';
import { errorResponseSchema } from '../../schemas/common.schema';
import {
  createMeasurementBodySchema,
  latestMeasurementQuerySchema,
  listMeasurementsQuerySchema,
  listMeasurementsResponseSchema,
  measurementResponseSchema,
} from '../../schemas/measurement.schema';

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

    if (error instanceof MeasurementDeviceNotFoundError) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: error.message,
      });
    }

    if (error instanceof DuplicateMeasurementError) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
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

  app.post(
    '/',
    {
      prefixTrailingSlash: 'no-slash',
      schema: {
        tags: ['Measurements'],
        summary: 'Create a measurement',
        description: 'Creates a measurement belonging to an existing device.',
        body: createMeasurementBodySchema,
        response: {
          201: measurementResponseSchema,
          400: errorResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const measurement = await addMeasurement(app.prisma, request.body);

      return reply.code(201).send(measurement);
    },
  );

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
          400: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      return listMeasurements(app.prisma, request.query);
    },
  );

  app.get(
    '/latest',
    {
      prefixTrailingSlash: 'no-slash',
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
        },
      },
    },
    async (request) => {
      return latestMeasurement(app.prisma, request.query);
    },
  );
};

export default measurements;
