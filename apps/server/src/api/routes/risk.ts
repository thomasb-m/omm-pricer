import { FastifyInstance } from "fastify";
import { volService } from "../../volModels/integration/volModelService";

export async function riskRoutes(f: FastifyInstance) {
  f.get("/risk/factors", async (req, rep) => {
    const { symbol = "BTC" } = (req.query as any) ?? {};
    const factors = volService.getFactorInventory(symbol);
    return {
      symbol,
      inventory: factors.inventory,
      lambda: factors.lambda,
      lambdaDotInventory: factors.lambdaDotInventory,
      timestamp: Date.now()
    };
  });
}
