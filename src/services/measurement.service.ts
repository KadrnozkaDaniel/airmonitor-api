import { Prisma, type PrismaClient } from '../../prisma/generated/client';
import type {
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

export const listMeasurements = async (
  prisma: PrismaClient,
  query: ListMeasurementsQuery,
): Promise<ListMeasurementsResponse> => {
  const { deviceId, page, limit } = query;

  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { id: true },
  });

  if (!device) throw new DeviceNotFoundError();

  const where: Prisma.MeasurementWhereInput = { deviceId };

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
