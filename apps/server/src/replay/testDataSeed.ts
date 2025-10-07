import { PrismaClient } from "@prisma/client";

export async function seedTestData(prisma: PrismaClient) {
  // Clear existing test data
  await prisma.ticker.deleteMany({
    where: { 
      instrument: "BTC-PERPETUAL",
      tsMs: { gte: BigInt(1759752130000), lte: BigInt(1759752131000) }
    }
  });

  // Insert fixed test ticks
  const testTicks = [
    { tsMs: BigInt(1759752130999), markPrice: 100000.0, underlying: 100000.0 },
  ];

  await prisma.ticker.createMany({
    data: testTicks.map(t => ({
      instrument: "BTC-PERPETUAL",
      tsMs: t.tsMs,
      markPrice: t.markPrice,
      markIv: 0.35,
      bestBid: t.markPrice * 0.9999,
      bestAsk: t.markPrice * 1.0001,
      underlying: t.underlying
    }))
  });

  console.log(`[testDataSeed] Seeded ${testTicks.length} test ticks`);
}
