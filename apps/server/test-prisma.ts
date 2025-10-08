import { PrismaClient } from '@prisma/client';

async function test() {
  const prisma = new PrismaClient();
  await prisma.$connect();
  console.log('Connected!');
  const models = Object.keys(prisma).filter(k => !k.startsWith('_') && !k.startsWith('$'));
  console.log('Models:', models);
  await prisma.$disconnect();
}

test().catch(console.error);
