import z from 'zod';

export const meResponseSchema = z.object({
  id: z.uuid(),
  email: z.email(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;
