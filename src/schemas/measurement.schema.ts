import z from 'zod';

export const createMeasurementBodySchema = z.strictObject({
  deviceId: z.uuid(),
  eco2: z.int32(),
  tvoc: z.int32(),
  measuredAt: z.iso.datetime({ offset: true }),
});

export const measurementResponseSchema = z.object({
  id: z.uuid(),
  eco2: z.int32(),
  tvoc: z.int32(),
  measuredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
});

export const listMeasurementsQuerySchema = z.strictObject({
  deviceId: z.uuid(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const listMeasurementsResponseSchema = z.object({
  data: z.array(measurementResponseSchema),

  pagination: z.object({
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
});

export const measurementErrorResponseSchema = z.object({
  statusCode: z.number().int().min(400).max(599),
  error: z.string(),
  message: z.string(),
});

export type CreateMeasurementBody = z.infer<typeof createMeasurementBodySchema>;
export type MeasurementResponse = z.infer<typeof measurementResponseSchema>;
export type ListMeasurementsQuery = z.infer<typeof listMeasurementsQuerySchema>;
export type ListMeasurementsResponse = z.infer<
  typeof listMeasurementsResponseSchema
>;
