import fp from 'fastify-plugin';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../prisma/generated/client';
import 'dotenv/config';

export default fp(
  async (fastify) => {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error('DATABASE_URL env is missing');
    }

    const adapter = new PrismaPg({ connectionString });
    const prisma = new PrismaClient({ adapter });

    fastify.addHook('onClose', async () => {
      await prisma.$disconnect();
    });

    await prisma.$connect();

    fastify.decorate('prisma', prisma);
  },
  { name: 'prisma' },
);

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}
