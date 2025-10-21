import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { priceCC } from "../cc/priceCC";
import { sviIV } from "@vol-core/smile";
import { bpsToAbs } from "@vol-core/units";

// Types (lightweight)
type SVIParams = { a:number; b:number; rho:number; m:number; sigma:number; };
type InstrumentMeta = { strike:number; symbol?:string; contractSize?:number; tickSize?:number; lotSize?:number; };
type Quote = { instrument: InstrumentMeta; forward: number };

// Where we expect fixtures
const FIX_PATH = path.resolve(process.cwd(), "vol-core-validation/output/cc_fixtures.json");

// Helper: clamp
const clamp = (x:number, lo:number, hi:number) => Math.min(Math.max(x, lo), hi);

describe("CC pricing parity vs Python fixtures (0.5 vol-bp / 0.5 bp)", () => {
  const exists = fs.existsSync(FIX_PATH);

  if (!exists) {
    it.skip(`No fixtures found at ${FIX_PATH} — skipping CC parity`, () => {});
    return;
  }

  const raw = fs.readFileSync(FIX_PATH, "utf8");
  const data = JSON.parse(raw);

  // Support both: {fixtures:[...]} or a single object
  const fixtures: any[] = Array.isArray(data?.fixtures) ? data.fixtures : (Array.isArray(data) ? data : [data]);

  for (const [idx, f] of fixtures.entries()) {
    const F:number = f.forward ?? f.F;
    const T:number = f.T ?? f.tau ?? f.time ?? 0;
    const df:number = f.df ?? 1.0;
    const svi:SVIParams = f.svi ?? f.svi_params ?? { a:f.a, b:f.b, rho:f.rho, m:f.m, sigma:f.sigma };

    const strikes:number[] = f.strikes ?? f.Ks ?? [];
    const marketIV:number[] | undefined = f.marketIV ?? f.ivs ?? undefined;
    const marketTV:number[] | undefined = f.marketTV ?? f.tvs ?? undefined;

    it(`fixture #${idx+1} (F=${F}, T=${T}, strikes=${strikes.length})`, () => {
      expect(Number.isFinite(F) && Number.isFinite(T)).toBe(true);
      expect(strikes.length).toBeGreaterThan(0);

      for (let i=0;i<strikes.length;i++) {
        const K = strikes[i];
        const q: Quote = { instrument: { strike: K }, forward: F };
        const out = priceCC(q, svi, T, df);

        if (marketIV && Number.isFinite(marketIV[i])) {
          // 0.5 vol-bp = 0.00005
          const k = Math.log(K / F);
          const ivModel = sviIV(k, T, svi);
          const ivMkt = clamp(marketIV[i], 0, 5);
          const dIV = Math.abs(ivModel - ivMkt);
          expect(dIV).toBeLessThanOrEqual(5e-5);
        }

        if (marketTV && Number.isFinite(marketTV[i])) {
          const tvMkt = marketTV[i];
          const base = Math.max(out.price, 1e-12);
          const tolAbs = bpsToAbs(0.5, base); // 0.5 bp of model price
          const dTV = Math.abs(out.tv - tvMkt);
          expect(dTV).toBeLessThanOrEqual(tolAbs);
        }
      }
    });
  }
});
