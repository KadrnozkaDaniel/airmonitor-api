import z from 'zod';
import {
  paginatedResponseSchema,
  paginationQuerySchema,
} from './common.schema';
import {
  ECO2_MAX,
  ECO2_MIN,
  MAX_BATCH_SIZE,
  MAX_CLOCK_SKEW_MS,
  MAX_MEASUREMENT_AGE_MS,
  TVOC_MAX,
} from '../utils/constants';

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

const measurementInputSchema = z.strictObject({
  eco2: z.int().min(ECO2_MIN).max(ECO2_MAX),
  tvoc: z.int().min(0).max(TVOC_MAX),
  measuredAt: z.iso
    .datetime({ offset: true, abort: true })
    .refine((value) => Date.parse(value) <= Date.now() + MAX_CLOCK_SKEW_MS, {
      message: 'measuredAt must not be in the future',
    })
    .refine(
      (value) => Date.parse(value) >= Date.now() - MAX_MEASUREMENT_AGE_MS,
      { message: 'measuredAt is too old' },
    ),
});

export const ingestMeasurementsBodySchema = z.strictObject({
  measurements: z
    .array(measurementInputSchema)
    .min(1)
    .max(MAX_BATCH_SIZE)
    .refine(
      (value) =>
        new Set(value.map(({ measuredAt }) => Date.parse(measuredAt))).size ===
        value.length,
      { message: 'Batch contains duplicate measuredAt' },
    ),
});

export const ingestMeasurementsResponseSchema = z.object({
  received: z.int().nonnegative(),
  inserted: z.int().nonnegative(),
  duplicates: z.int().nonnegative(),
});

export const latestMeasurementQuerySchema = z.strictObject({
  deviceId: z.uuid(),
});

export const listMeasurementsResponseSchema = paginatedResponseSchema(
  measurementResponseSchema,
);

export type MeasurementResponse = z.infer<typeof measurementResponseSchema>;
export type ListMeasurementsQuery = z.infer<typeof listMeasurementsQuerySchema>;
export type LatestMeasurementQuery = z.infer<
  typeof latestMeasurementQuerySchema
>;
export type ListMeasurementsResponse = z.infer<
  typeof listMeasurementsResponseSchema
>;
export type IngestMeasurementsBody = z.infer<
  typeof ingestMeasurementsBodySchema
>;
export type IngestMeasurementsResponse = z.infer<
  typeof ingestMeasurementsResponseSchema
>;
