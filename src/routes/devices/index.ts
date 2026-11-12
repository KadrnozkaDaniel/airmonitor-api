import { ZodTypeProvider } from '@fastify/type-provider-zod';
import { FastifyPluginAsync } from 'fastify';
import {
  createDevice,
  deviceDetail,
  DeviceNotFoundError,
  listDevices,
} from '../../services/device.service';
import {
  createDeviceBodySchema,
  deviceDetailParamsSchema,
  deviceResponseSchema,
  listDevicesQuerySchema,
  listDevicesResponseSchema,
} from '../../schemas/device.schema';
import {
  authErrorResponses,
  errorResponseSchema,
} from '../../schemas/common.schema';
import { requireUser } from '../../plugins/auth';

const devices: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('onRequest', app.authenticate);

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
      ((error.statusCode >= 400 && error.statusCode < 500) ||
        error.statusCode === 503)
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
        description: 'Creates a device owned by the authenticated user',
        body: createDeviceBodySchema,
        response: {
          201: deviceResponseSchema,
          400: errorResponseSchema,
          500: errorResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const device = await createDevice(app.prisma, user.id, request.body);

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
        description: 'Returns a paginated list of your devices',
        querystring: listDevicesQuerySchema,
        response: {
          200: listDevicesResponseSchema,
          400: errorResponseSchema,
          500: errorResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => {
      const user = requireUser(request);
      return listDevices(app.prisma, user.id, request.query);
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
          400: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => {
      const user = requireUser(request);
      return deviceDetail(app.prisma, user.id, request.params.id);
    },
  );
};

export default devices;
