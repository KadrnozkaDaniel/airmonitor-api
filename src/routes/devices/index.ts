import { ZodTypeProvider } from '@fastify/type-provider-zod';
import { FastifyPluginAsync } from 'fastify';
import {
  createDevice,
  deviceDetail,
  DeviceNotFoundError,
  DeviceOwnerNotFoundError,
  listDevices,
} from '../../services/device.service';
import {
  createDeviceBodySchema,
  deviceDetailParamsSchema,
  deviceErrorResponseSchema,
  deviceResponseSchema,
  listDevicesQuerySchema,
  listDevicesResponseSchema,
} from '../../schemas/device.schema';

const devices: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DeviceNotFoundError) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: error.message,
      });
    }

    if (error instanceof DeviceOwnerNotFoundError) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'Device oenew dos not exist',
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

    request.log.error({ err: error }, 'Device request failed');

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
        tags: ['Devices'],
        summary: 'Create a device',
        description: 'Creates a device belonging to an existing owner.',
        body: createDeviceBodySchema,
        response: {
          201: deviceResponseSchema,
          400: deviceErrorResponseSchema,
          422: deviceErrorResponseSchema,
          500: deviceErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const device = await createDevice(app.prisma, request.body);

      return reply.code(201).send(device);
    },
  );

  app.get(
    '/',
    {
      prefixTrailingSlash: 'no-slash',
      schema: {
        tags: ['Devices'],
        summary: 'Devices List',
        description: 'Returns a paginated list of devices',
        querystring: listDevicesQuerySchema,
        response: {
          200: listDevicesResponseSchema,
          400: deviceErrorResponseSchema,
          500: deviceErrorResponseSchema,
        },
      },
    },
    async (request) => {
      return listDevices(app.prisma, request.query);
    },
  );

  app.get(
    '/:id',
    {
      prefixTrailingSlash: 'no-slash',
      schema: {
        tags: ['Devices'],
        summary: 'Device detail',
        description: 'Returns a device detail',
        params: deviceDetailParamsSchema,
        response: {
          200: deviceResponseSchema,
          400: deviceErrorResponseSchema,
          404: deviceErrorResponseSchema,
          500: deviceErrorResponseSchema,
        },
      },
    },
    async (request) => {
      return deviceDetail(app.prisma, request.params.id);
    },
  );
};

export default devices;
