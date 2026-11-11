import { Prisma, type PrismaClient } from '../../prisma/generated/client';
import type {
  CreateMeasurementBody,
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

export class MeasurementDeviceNotFoundError extends Error {
  constructor() {
    super('Measurement device does not exist');
    this.name = 'MeasurementDeviceNotFoundError';
  }
}

export class DuplicateMeasurementError extends Error {
  constructor() {
    super('Measurement for this device and time already exists');
    this.name = 'DuplicateMeasurementError';
  }
}

export const listMeasurements = async (
  prisma: PrismaClient,
  query: ListMeasurementsQuery,
): Promise<ListMeasurementsResponse> => {
  const { deviceId, page, limit, from, to } = query;

  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { id: true },
  });

  if (!device) throw new DeviceNotFoundError();

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

export const addMeasurement = async (
  prisma: PrismaClient,
  input: CreateMeasurementBody,
): Promise<MeasurementResponse> => {
  try {
    const measurement = await prisma.measurement.create({
      data: {
        deviceId: input.deviceId,
        measuredAt: input.measuredAt,
        eco2: input.eco2,
        tvoc: input.tvoc,
      },
      select: measurementSelect,
    });

    return toMeasurementResponse(measurement);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2003') throw new MeasurementDeviceNotFoundError();
      if (e.code === 'P2002') throw new DuplicateMeasurementError();
    }
    throw e;
  }
};
