import z from 'zod';

export const errorResponseSchema = z.object({
  statusCode: z.number().int().min(400).max(599),
  error: z.string(),
  message: z.string(),
});

export const paginationQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const paginationSchema = z.object({
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

export const paginatedResponseSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    pagination: paginationSchema,
  });

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type Pagination = z.infer<typeof paginationSchema>;
