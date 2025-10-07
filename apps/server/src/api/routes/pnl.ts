import { FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";

export async function pnlRoutes(f: FastifyInstance) {
  f.get("/pnl/summary", async (_req, _rep) => {
    const file = path.resolve("data/trades.jsonl");
    if (!fs.existsSync(file)) {
      return { count: 0, totalEdge: 0, avgEdge: 0 };
    }
    
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    let totalEdge = 0;
    
    for (const ln of lines) {
      try {
        const r = JSON.parse(ln);
        totalEdge += r.pnl_est ?? 0;
      } catch {}
    }
    
    return {
      count: lines.length,
      totalEdge: parseFloat(totalEdge.toFixed(2)),
      avgEdge: lines.length ? parseFloat((totalEdge / lines.length).toFixed(4)) : 0,
      timestamp: Date.now()
    };
  });
}
