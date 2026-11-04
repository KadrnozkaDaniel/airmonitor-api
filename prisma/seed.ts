import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) throw new Error('DATABASE_URL env is missing');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

const main = async () => {
  await prisma.$transaction(async (tx) => {
    const owner = await tx.user.upsert({
      where: { email: 'admin@admin.cz' },
      update: {},
      create: { email: 'admin@admin.cz' },
    });

    const devices = [
      {
        id: 'b061055f-aa99-4c41-a77c-9dac1a7307cc',
        name: 'Bedroom',
      },
      { id: '6ee1d6e5-1e43-4dcf-bcfa-2ce27395b1bc', name: 'Living room' },
    ];

    const startTime = new Date('2026-11-04T08:00:00.000Z');

    for (const device of devices) {
      await tx.device.upsert({
        where: { id: device.id },
        update: {},
        create: {
          id: device.id,
          name: device.name,
          ownerId: owner.id,
        },
      });

      await tx.measurement.createMany({
        data: Array.from({ length: 50 }, (_, i) => ({
          deviceId: device.id,
          eco2: 600 + (i % 10) * 25,
          tvoc: 50 + (i % 8) * 10,
          measuredAt: new Date(startTime.getTime() + i * 60_000),
        })),
        skipDuplicates: true,
      });
    }
  });
};

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
