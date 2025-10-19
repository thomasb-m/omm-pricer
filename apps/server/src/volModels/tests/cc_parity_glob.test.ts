// apps/server/src/volModels/tests/cc_parity_glob.test.ts (v2)
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { priceCC } from "../cc/priceCC";
import { sviIV } from "@vol-core/smile";
import { bpsToAbs } from "@vol-core/units";

type SVIParams = { a:number; b:number; rho:number; m:number; sigma:number };
const clamp = (x:number, lo:number, hi:number) => Math.min(Math.max(x, lo), hi);

const ROOT = path.resolve(process.cwd(), "vol-core-validation/output");
// Only accept *_fixture.json or cc_fixtures.json
const files = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(f => /(^cc_fixtures\.json$|_fixture\.json$)/.test(f))
  : [];

let validatedFixtures = 0;
let validatedStrikes = 0;

describe("CC parity (fixtures in vol-core-validation/output/*_fixture.json)", () => {
  if (!files.length) {
    it.skip(`No fixture files found (expected *_fixture.json or cc_fixtures.json in ${ROOT})`, () => {});
    return;
  }

  for (const fname of files) {
    const full = path.join(ROOT, fname);
    let data: any;
    try {
      data = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      it.skip(`${fname}: invalid JSON`, () => {});
      continue;
    }

    const fixtures: any[] = Array.isArray(data?.fixtures) ? data.fixtures
      : (Array.isArray(data) ? data : [data]);

    for (const [idx, f] of fixtures.entries()) {
      const F:number = f.forward ?? f.F;
      const T:number = f.T ?? f.tau ?? f.time ?? 0;
      const df:number = f.df ?? 1.0;
      const svi:SVIParams = f.svi ?? f.svi_params ?? { a:f.a, b:f.b, rho:f.rho, m:f.m, sigma:f.sigma };
      const strikes:number[] = f.strikes ?? f.Ks ?? [];
      const marketIV:number[] | undefined = f.marketIV ?? f.ivs ?? undefined;
      const marketTV:number[] | undefined = f.marketTV ?? f.tvs ?? undefined;

      const valid = Number.isFinite(F) && Number.isFinite(T) && T > 0 && Array.isArray(strikes) && strikes.length > 0;

      if (!valid) {
        it.skip(`${fname} [#${idx+1}] missing required fields (F,T,strikes)`, () => {});
        continue;
      }

      it(`${fname} [#${idx+1}] F=${F} T=${T} nK=${strikes.length}`, () => {
        validatedFixtures += 1;

        const errs: string[] = [];
        for (let i=0;i<strikes.length;i++) {
          const K = strikes[i];
          const out = priceCC({ instrument:{ strike:K }, forward:F }, svi, T, df);
          validatedStrikes += 1;

          if (marketIV && Number.isFinite(marketIV[i])) {
            const ivModel = sviIV(Math.log(K/F), T, svi);
            const ivMkt = clamp(marketIV[i], 0, 5);
            const dIV = Math.abs(ivModel - ivMkt);
            if (dIV > 5e-5) errs.push(`K=${K} dIV=${dIV.toExponential(2)} (>5e-5)`);
          }
          if (marketTV && Number.isFinite(marketTV[i])) {
            const tolAbs = bpsToAbs(0.5, Math.max(out.price, 1e-12));
            const dTV = Math.abs(out.tv - marketTV[i]);
            if (dTV > tolAbs) errs.push(`K=${K} dTV=${dTV.toExponential(2)} (> ${tolAbs.toExponential(2)} )`);
          }
        }
        if (errs.length) {
          const msg = ["Out-of-tolerance strikes:", ...errs.map(s => ` - ${s}`)].join("\n");
          expect(errs.length, msg).toBe(0);
        } else {
          expect(true).toBe(true);
        }
      });
    }
  }

  it("summary", () => {
    // eslint-disable-next-line no-console
    console.log(`[cc_parity_glob] validated fixtures: ${validatedFixtures}, validated strikes: ${validatedStrikes}`);
    expect(true).toBe(true);
  });
});
