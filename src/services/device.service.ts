import { Prisma, type PrismaClient } from '../../prisma/generated/client';
import type {
  ApiKeyResponse,
  CreateDeviceBody,
  CreateDeviceResponse,
  DeviceResponse,
  ListDevicesQuery,
  ListDevicesResponse,
} from '../schemas/device.schema';
import { generateApiKey } from '../utils/api-key';

type SelectedDevice = Prisma.DeviceGetPayload<{
  select: typeof deviceSelect;
}>;

const deviceSelect = {
  id: true,
  name: true,
  description: true,
  ownerId: true,
  createdAt: true,
  lastSeenAt: true,
} satisfies Prisma.DeviceSelect;

const toDeviceResponse = (device: SelectedDevice): DeviceResponse => {
  return {
    id: device.id,
    name: device.name,
    description: device.description,
    ownerId: device.ownerId,
    createdAt: device.createdAt.toISOString(),
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
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
): Promise<CreateDeviceResponse> => {
  const { key, hash } = generateApiKey();
  const device = await prisma.device.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      ownerId,
      apiKeyHash: hash,
    },
    select: deviceSelect,
  });

  return { ...toDeviceResponse(device), apiKey: key };
};

export const rotateDeviceApiKey = async (
  prisma: PrismaClient,
  ownerId: string,
  id: string,
): Promise<ApiKeyResponse> => {
  const { key, hash } = generateApiKey();
  const { count } = await prisma.device.updateMany({
    where: { id, ownerId },
    data: {
      apiKeyHash: hash,
    },
  });
  if (count === 0) throw new DeviceNotFoundError();

  return { apiKey: key };
};
