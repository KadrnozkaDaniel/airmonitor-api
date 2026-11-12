import { Prisma, type PrismaClient } from '../../prisma/generated/client';
import type {
  CreateDeviceBody,
  DeviceResponse,
  ListDevicesQuery,
  ListDevicesResponse,
} from '../schemas/device.schema';

type SelectedDevice = Prisma.DeviceGetPayload<{
  select: typeof deviceSelect;
}>;

const deviceSelect = {
  id: true,
  name: true,
  description: true,
  ownerId: true,
  createdAt: true,
} satisfies Prisma.DeviceSelect;

const toDeviceResponse = (device: SelectedDevice): DeviceResponse => {
  return {
    id: device.id,
    name: device.name,
    description: device.description,
    ownerId: device.ownerId,
    createdAt: device.createdAt.toISOString(),
  };
};

export class DeviceNotFoundError extends Error {
  constructor() {
    super('Device does not exist');
    this.name = 'DeviceNotFoundError';
  }
}

export const listDevices = async (
  prisma: PrismaClient,
  ownerId: string,
  query: ListDevicesQuery,
): Promise<ListDevicesResponse> => {
  const { page, limit } = query;

  const where = { ownerId } satisfies Prisma.DeviceWhereInput;

  const [devices, total] = await prisma.$transaction(
    [
      prisma.device.findMany({
        where,
        select: deviceSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),

      prisma.device.count({ where }),
    ],
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  );

  return {
    data: devices.map(toDeviceResponse),

    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

export const deviceDetail = async (
  prisma: PrismaClient,
  ownerId: string,
  id: string,
): Promise<DeviceResponse> => {
  const device = await prisma.device.findUnique({
    where: { id, ownerId },
    select: deviceSelect,
  });

  if (!device) throw new DeviceNotFoundError();

  return toDeviceResponse(device);
};

export const createDevice = async (
  prisma: PrismaClient,
  ownerId: string,
  input: CreateDeviceBody,
): Promise<DeviceResponse> => {
  const device = await prisma.device.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      ownerId,
    },
    select: deviceSelect,
  });

  return toDeviceResponse(device);
};
