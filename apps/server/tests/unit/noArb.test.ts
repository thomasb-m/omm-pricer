import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { loadAggregatedCCFixtures } from "@vol-validation/cc_glob_loader";
import { checkStaticArbitrage, checkCalendarByK } from "@vol-core/noArb";
import { sviTotalVariance } from "@vol-core/smile";
import { asKRel } from "@vol-core/conventions";

const DIAG = path.resolve("diagnostics/noarb.json");

describe("Static No-Arb Guards", () => {
  const agg = loadAggregatedCCFixtures();
  const results: any[] = [];
  const calendarResults: any[] = [];

  describe("Per-Smile Static Checks", () => {
    agg.fixtures.forEach((f, idx) => {
      const label = f.metadata?.synthetic 
        ? `${f.fixtureId} (synthetic)` 
        : f.fixtureId ?? `idx_${idx}`;
      
      it(`Fixture ${idx}: ${label} - no static arb`, () => {
        const r = checkStaticArbitrage(f.strikes, f.forward, f.T, f.svi);
        
        // Compute min-margins (health metrics)
        const minVarConvexity = r.varConvexity.length > 0 
          ? Math.min(...r.varConvexity.map(v => v.d2w))
          : r.varConvexity.length === 0 ? Infinity : 0;
        
        const minCallConvexity = r.callConvexity.length > 0
          ? Math.min(...r.callConvexity.map(v => v.d2C))
          : r.callConvexity.length === 0 ? Infinity : 0;
        
        const minButterfly = r.wButterflies.length > 0
          ? Math.min(...r.wButterflies.map(b => b.value))
          : Infinity;
        
        results.push({
          fixtureId: f.fixtureId ?? `idx_${idx}`,
          synthetic: f.metadata?.synthetic ?? false,
          passed: r.passed,
          wingSlopes: r.wingSlopes,
          violations: {
            varConvexity: r.varConvexity.length,
            butterflies: r.wButterflies.filter(b => b.violates).length,
            callConvexity: r.callConvexity.length,
          },
          margins: {
            minVarConvexity: minVarConvexity === Infinity ? null : minVarConvexity,
            minCallConvexity: minCallConvexity === Infinity ? null : minCallConvexity,
            minButterfly: minButterfly === Infinity ? null : minButterfly,
          }
        });
        
        if (!r.passed) {
          console.log(`\n⚠️ Static arb violations in fixture ${idx}:`);
          if (!r.wingSlopes.leftOK || !r.wingSlopes.rightOK) {
            console.log("  Wing slopes:", r.wingSlopes);
          }
          if (r.varConvexity.length > 0) {
            console.log(`  Variance convexity: ${r.varConvexity.length} violations (min d²w: ${minVarConvexity.toExponential(2)})`);
          }
          if (r.wButterflies.some(b => b.violates)) {
            const count = r.wButterflies.filter(b => b.violates).length;
            console.log(`  Butterflies: ${count} violations (min: ${minButterfly.toExponential(2)})`);
          }
          if (r.callConvexity.length > 0) {
            console.log(`  Call convexity: ${r.callConvexity.length} violations (min d²C: ${minCallConvexity.toExponential(2)})`);
          }
        }
        
        expect(r.passed).toBe(true);
      });
    });
  });

  describe("Calendar Arbitrage (k-space)", () => {
    if (agg.fixtures.length < 2) {
      it.skip("Need ≥2 expiries for calendar check", () => {});
    } else {
      const sorted = [...agg.fixtures].sort((a, b) => a.T - b.T);
      const kGrid: number[] = [];
      for (let k = -2.5; k <= 2.5; k += 0.1) kGrid.push(k);
      
      for (let i = 0; i < sorted.length - 1; i++) {
        const f1 = sorted[i];
        const f2 = sorted[i + 1];
        
        it(`${f1.fixtureId} → ${f2.fixtureId} - no calendar arb`, () => {
          const violations = checkCalendarByK(
            f1.forward, f1.T, f1.svi,
            f2.forward, f2.T, f2.svi,
            kGrid
          );
          
          // Compute min calendar margin (w2-w1) across k-grid
          let minMargin = Infinity;
          let minMarginK = 0;
          
          for (const k of kGrid) {
            const w1 = sviTotalVariance(asKRel(k), f1.svi);
            const w2 = sviTotalVariance(asKRel(k), f2.svi);
            const margin = w2 - w1;
            if (margin < minMargin) {
              minMargin = margin;
              minMarginK = k;
            }
          }
          
          calendarResults.push({
            from: f1.fixtureId,
            to: f2.fixtureId,
            T1: f1.T,
            T2: f2.T,
            violations: violations.length,
            minMargin: minMargin,
            minMarginK: minMarginK,
            minMarginBps: (minMargin / Math.max(1e-10, Math.abs(minMargin))) * 1e4,
          });
          
          if (violations.length > 0) {
            console.log(`\n⚠️ Calendar violations (${violations.length}):`);
            console.log(`  Min margin: ${minMargin.toExponential(3)} at k=${minMarginK.toFixed(2)}`);
            violations.slice(0, 3).forEach(v => {
              console.log(`    k=${v.k.toFixed(2)}: w1=${v.w1.toFixed(6)}, w2=${v.w2.toFixed(6)}`);
            });
          }
          
          expect(violations.length).toBe(0);
        });
      }
    }
  });

  afterAll(() => {
    const summary = {
      timestamp: new Date().toISOString(),
      conventions: {
        k: "ln(K/F)",
        family: "svi_raw",
        tolerances: {
          varConvexity: "3e-6",
          butterfly: "1e-8",
          calendar: "2.0 bp relative",
        },
      },
      static: {
        totalFixtures: results.length,
        passed: results.filter(r => r.passed).length,
        failed: results.filter(r => !r.passed).length,
        synthetic: results.filter(r => r.synthetic).length,
        fixtures: results,
      },
      calendar: {
        totalPairs: calendarResults.length,
        violations: calendarResults.reduce((sum, r) => sum + r.violations, 0),
        pairs: calendarResults,
      },
    };
    
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.writeFileSync(DIAG, JSON.stringify(summary, null, 2));
    
    console.log("\n" + "=".repeat(70));
    console.log("NO-ARB DIAGNOSTICS");
    console.log("=".repeat(70));
    console.log(`Static: ${summary.static.passed}/${summary.static.totalFixtures} passed (${summary.static.synthetic} synthetic)`);
    console.log(`Calendar: ${summary.calendar.totalPairs} pairs, ${summary.calendar.violations} violations`);
    console.log(`Diagnostics: ${DIAG}`);
    console.log("=".repeat(70));
  });
});
