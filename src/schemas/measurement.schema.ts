import z from 'zod';
import {
  paginatedResponseSchema,
  paginationQuerySchema,
} from './common.schema';

export const createMeasurementBodySchema = z.strictObject({
  deviceId: z.uuid(),
  eco2: z.int32().nonnegative(),
  tvoc: z.int32().nonnegative(),
  measuredAt: z.iso.datetime({ offset: true }),
});

export const measurementResponseSchema = z.object({
  id: z.uuid(),
  eco2: z.int32(),
  tvoc: z.int32(),
  measuredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
});

export const listMeasurementsQuerySchema = paginationQuerySchema
  .extend({
    deviceId: z.uuid(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .refine(
    ({ from, to }) => {
      if (!from || !to) return true;
      return new Date(from) <= new Date(to);
    },
    { message: 'From must not be later than to', path: ['from'] },
  );

export const latestMeasurementQuerySchema = z.strictObject({
  deviceId: z.uuid(),
});

export const listMeasurementsResponseSchema = paginatedResponseSchema(
  measurementResponseSchema,
);

export type CreateMeasurementBody = z.infer<typeof createMeasurementBodySchema>;
export type MeasurementResponse = z.infer<typeof measurementResponseSchema>;
export type ListMeasurementsQuery = z.infer<typeof listMeasurementsQuerySchema>;
export type LatestMeasurementQuery = z.infer<
  typeof latestMeasurementQuerySchema
>;
export type ListMeasurementsResponse = z.infer<
  typeof listMeasurementsResponseSchema
>;
