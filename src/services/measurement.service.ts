import { Prisma, type PrismaClient } from '../../prisma/generated/client';
import type {
  IngestMeasurementsBody,
  IngestMeasurementsResponse,
  LatestMeasurementQuery,
  ListMeasurementsQuery,
  ListMeasurementsResponse,
  MeasurementResponse,
} from '../schemas/measurement.schema';
import { DeviceNotFoundError } from './device.service';

type SelectedMeasurement = Prisma.MeasurementGetPayload<{
  select: typeof measurementSelect;
}>;

const measurementSelect = {
  id: true,
  measuredAt: true,
  receivedAt: true,
  eco2: true,
  tvoc: true,
} satisfies Prisma.MeasurementSelect;

const toMeasurementResponse = (
  measurement: SelectedMeasurement,
): MeasurementResponse => {
  return {
    id: measurement.id,
    eco2: measurement.eco2,
    tvoc: measurement.tvoc,
    measuredAt: measurement.measuredAt.toISOString(),
    receivedAt: measurement.receivedAt.toISOString(),
  };
};

export class MeasurementNotFoundError extends Error {
  constructor() {
    super('Measurement does not exist');
    this.name = 'MeasurementNotFoundError';
  }
}

const assertDeviceOwnedBy = async (
  prisma: PrismaClient,
  ownerId: string,
  deviceId: string,
): Promise<void> => {
  const device = await prisma.device.findUnique({
    where: { id: deviceId, ownerId },
    select: { id: true },
  });

  if (!device) throw new DeviceNotFoundError();
};

export const listMeasurements = async (
  prisma: PrismaClient,
  ownerId: string,
  query: ListMeasurementsQuery,
): Promise<ListMeasurementsResponse> => {
  const { deviceId, page, limit, from, to } = query;

  await assertDeviceOwnedBy(prisma, ownerId, deviceId);

  const where: Prisma.MeasurementWhereInput = {
    deviceId,
    measuredAt: {
      gte: from ? new Date(from) : undefined,
      lte: to ? new Date(to) : undefined,
    },
  };

  const [measurements, total] = await prisma.$transaction(
    [
      prisma.measurement.findMany({
        where,
        select: measurementSelect,
        orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),

      prisma.measurement.count({ where }),
    ],
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  );

  return {
    data: measurements.map(toMeasurementResponse),

    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

export const latestMeasurement = async (
  prisma: PrismaClient,
  ownerId: string,
  query: LatestMeasurementQuery,
): Promise<MeasurementResponse> => {
  const { deviceId } = query;

  await assertDeviceOwnedBy(prisma, ownerId, deviceId);

  const measurement = await prisma.measurement.findFirst({
    where: { deviceId },
    select: measurementSelect,
    orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
  });

  if (!measurement) throw new MeasurementNotFoundError();

  return toMeasurementResponse(measurement);
};

export const ingestMeasurements = async (
  prisma: PrismaClient,
  deviceId: string,
  input: IngestMeasurementsBody,
): Promise<IngestMeasurementsResponse> => {
  const { count } = await prisma.measurement.createMany({
    data: input.measurements.map(({ eco2, tvoc, measuredAt }) => ({
      deviceId,
      eco2,
      tvoc,
      measuredAt,
    })),
    skipDuplicates: true,
  });

  return {
    received: input.measurements.length,
    inserted: count,
    duplicates: input.measurements.length - count,
  };
};
