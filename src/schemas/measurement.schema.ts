import z from "zod";

export const measurementSchema = z.object({
  id: z.number().int().positive().describe("Measurement ID"),
  temperature: z.number().describe("Temperature in C°"),
  humidity: z.number().min(0).max(100).describe("Relative humidity in %"),
});

export const measurementsResponseSchema = z.array(measurementSchema);

export type Measurement = z.infer<typeof measurementSchema>;
export type MeasurementsResponse = z.infer<typeof measurementsResponseSchema>;
