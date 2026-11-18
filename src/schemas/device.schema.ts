import z from 'zod';
import {
  paginatedResponseSchema,
  paginationQuerySchema,
} from './common.schema';

export const createDeviceBodySchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, 'Device name is required')
    .max(100, 'Device name must not exceed 100 characters'),
  description: z
    .string()
    .trim()
    .max(1000, 'Description must not exceed 1000 characters')
    .nullable()
    .optional(),
});

export const deviceResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  ownerId: z.uuid(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
});

export const listDevicesQuerySchema = paginationQuerySchema;

export const listDevicesResponseSchema =
  paginatedResponseSchema(deviceResponseSchema);

export const deviceDetailParamsSchema = z.strictObject({
  id: z.uuid(),
});

export const apiKeyResponseSchema = z.object({
  apiKey: z.string().meta({
    description:
      'Device API key, is shown only once, cannot be retreived again',
  }),
});

export const createDeviceResponseSchema = deviceResponseSchema.extend(
  apiKeyResponseSchema.shape,
);

export type CreateDeviceBody = z.infer<typeof createDeviceBodySchema>;
export type DeviceResponse = z.infer<typeof deviceResponseSchema>;
export type ListDevicesQuery = z.infer<typeof listDevicesQuerySchema>;
export type ListDevicesResponse = z.infer<typeof listDevicesResponseSchema>;
export type CreateDeviceResponse = z.infer<typeof createDeviceResponseSchema>;
export type ApiKeyResponse = z.infer<typeof apiKeyResponseSchema>;
