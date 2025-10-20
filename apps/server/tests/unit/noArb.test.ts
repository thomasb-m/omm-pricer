import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { loadAggregatedCCFixtures } from "@vol-validation/cc_glob_loader";
import { checkStaticArbitrage, checkCalendarByK } from "@vol-core/noArb";

const DIAG = path.resolve("diagnostics/noarb.json");

describe("Static No-Arb Guards", () => {
  const agg = loadAggregatedCCFixtures();
  const results: any[] = [];

  describe("Per-Smile Static Checks", () => {
    agg.fixtures.forEach((f, idx) => {
      it(`Fixture ${idx}: ${f.fixtureId ?? "unnamed"} - no static arb`, () => {
        const r = checkStaticArbitrage(f.strikes, f.forward, f.T, f.svi);
        results.push({
          fixtureId: f.fixtureId ?? `idx_${idx}`,
          passed: r.passed,
          wingSlopes: r.wingSlopes,
          varConvexityCount: r.varConvexity.length,
          butterflyCount: r.wButterflies.filter(b => b.violates).length,
          callConvexityCount: r.callConvexity.length,
        });
        expect(r.passed).toBe(true);
      });
    });
  });

  describe("Calendar Arbitrage (k-space)", () => {
    if (agg.fixtures.length < 2) {
      it.skip("Need ≥2 expiries for calendar check", () => {});
    } else {
      const sorted = [...agg.fixtures].sort((a, b) => a.T - b.T);
      const kGrid: number[] = []; for (let k=-2.5; k<=2.5; k+=0.1) kGrid.push(k);
      for (let i = 0; i < sorted.length - 1; i++) {
        const f1 = sorted[i], f2 = sorted[i+1];
        it(`${f1.fixtureId} → ${f2.fixtureId} - no calendar arb`, () => {
          const v = checkCalendarByK(f1.forward, f1.T, f1.svi, f2.forward, f2.T, f2.svi, kGrid);
          expect(v.length).toBe(0);
        });
      }
    }
  });

  afterAll(() => {
    const summary = {
      timestamp: new Date().toISOString(),
      fixtures: results,
      totalFixtures: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
    };
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.writeFileSync(DIAG, JSON.stringify(summary, null, 2));
    console.log(`No-arb diagnostics: ${DIAG}`);
  });
});
