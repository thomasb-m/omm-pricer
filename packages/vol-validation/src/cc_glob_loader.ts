import fs from "fs";
import path from "path";
import { z } from "zod";
import crypto from "crypto";

const SVIParamsSchema = z.object({
  a: z.number(),
  b: z.number().nonnegative(),
  rho: z.number().min(-1).max(1),
  m: z.number(),
  sigma: z.number().positive(),
});

const UnitsSchema = z.object({
  k: z.literal("ln(K/F)"),
  T: z.string().regex(/^years_/),
  iv: z.literal("ann_stdev"),
  w: z.literal("total_variance"),
  price: z.literal("pv"),
});

const AggregatedFixtureSchema = z.object({
  forward: z.number().positive(),
  T: z.number().positive(),
  strikes: z.array(z.number().positive()).min(1),
  marketIV: z.array(z.number()).min(1),
  marketW: z.array(z.number()).min(1),
  df: z.number().positive().optional(),
  svi: SVIParamsSchema,
  param_family: z.literal("svi_raw"),
  units: UnitsSchema,
  metadata: z.record(z.string(), z.any()).optional(),
  fixtureId: z.string().optional(),
});

const AggregatedFileSchema = z.object({
  fixtures: z.array(AggregatedFixtureSchema),
  hash: z.string().optional(),
});

export interface AggregatedFixture {
  forward: number;
  T: number;
  strikes: number[];
  marketIV: number[];
  marketW: number[];
  df?: number;
  svi: { a: number; b: number; rho: number; m: number; sigma: number };
  param_family: "svi_raw";
  units: {
    k: "ln(K/F)";
    T: string;
    iv: "ann_stdev";
    w: "total_variance";
    price: "pv";
  };
  metadata?: any;
  fixtureId?: string;
}

export interface AggregatedFile {
  fixtures: AggregatedFixture[];
  hash?: string;
}

export function loadAggregatedCCFixtures(
  file = "vol-core-validation/output/cc_fixtures.json"
): AggregatedFile {
  const fullPath = path.resolve(file);

  try {
    const raw = fs.readFileSync(fullPath, "utf-8");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const data = JSON.parse(raw);
    const validated = AggregatedFileSchema.parse(data);
    
    validated.fixtures.forEach((f, idx) => {
      if (f.strikes.length !== f.marketIV.length || 
          f.strikes.length !== f.marketW.length) {
        throw new Error(`Fixture ${idx}: Array length mismatch`);
      }
      
      if (Math.abs(f.svi.rho) >= 1) {
        throw new Error(`Fixture ${idx}: Invalid |ρ| >= 1`);
      }
      
      for (let j = 0; j < f.strikes.length; j++) {
        const computedW = f.marketIV[j] * f.marketIV[j] * f.T;
        const diff = Math.abs(computedW - f.marketW[j]);
        if (diff > 1e-6) {
          console.warn(
            `Fixture ${idx} strike ${j}: W mismatch (computed=${computedW.toFixed(6)}, ` +
            `provided=${f.marketW[j].toFixed(6)}, diff=${diff.toFixed(8)})`
          );
        }
      }
    });
    
    return { ...validated, hash };
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error(`❌ Fixture schema validation failed: ${file}`);
      console.error("Violations:");
      err.issues.forEach(issue => {
        console.error(`  ${issue.path.join('.')}: ${issue.message}`);
      });
      throw new Error(`Invalid fixture schema - see errors above`);
    }
    throw err;
  }
}
