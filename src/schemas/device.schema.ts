import z from 'zod';

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
  ownerId: z.uuid(),
});

export const deviceResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  ownerId: z.uuid(),
  createdAt: z.iso.datetime(),
});

export const deviceErrorResponseSchema = z.object({
  statusCode: z.number().int().min(400).max(599),
  error: z.string(),
  message: z.string(),
});

export const listDevicesQuerySchema = z.strictObject({
  ownerId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const listDevicesResponseSchema = z.object({
  data: z.array(deviceResponseSchema),

  pagination: z.object({
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
});

export const deviceDetailParamsSchema = z.strictObject({
  id: z.uuid(),
});

export type CreateDeviceBody = z.infer<typeof createDeviceBodySchema>;
export type DeviceResponse = z.infer<typeof deviceResponseSchema>;
export type ListDevicesQuery = z.infer<typeof listDevicesQuerySchema>;
export type ListDevicesResponse = z.infer<typeof listDevicesResponseSchema>;
