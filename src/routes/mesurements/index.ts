import { FastifyPluginAsync } from 'fastify';
import {
  measurementsResponseSchema,
  type MeasurementsResponse,
} from '../../schemas/measurement.schema';

const measurements: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/',
    {
      prefixTrailingSlash: 'no-slash',
      schema: {
        tags: ['Measurements'],
        summary: 'Get measurements',
        description: 'Returns a list of measurements',

        response: {
          200: measurementsResponseSchema,
        },
      },
    },
    async (): Promise<MeasurementsResponse> => {
      return [
        {
          id: 1,
          temperature: 22.5,
          humidity: 48,
        },
      ];
    },
  );
};

export default measurements;
