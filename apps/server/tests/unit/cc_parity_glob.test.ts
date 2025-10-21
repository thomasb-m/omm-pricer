import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { loadAggregatedCCFixtures } from "@vol-validation/cc_glob_loader";
import { sviIV, sviTotalVariance, validateSVIParams } from "@vol-core/smile";
import { kRel, CONVENTIONS } from "@vol-core/conventions";
import { IV_TOL_MIN_BPS, IV_TOL_MAX_BPS, IV_TOL_PCT, W_TOL_REL_BPS, EPS_W_ABS } from "@vol-core/constants";

const DIAG_PATH = path.resolve("diagnostics/cc_parity.json");

function rmse(a: number[], b: number[]): number {
  const n = Math.max(1, Math.min(a.length, b.length));
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / n);
}

describe("CC Parity — Python Goldens (Unit Wall)", () => {
  const agg = loadAggregatedCCFixtures();

  // Verify all fixtures declare canonical conventions
  agg.fixtures.forEach((f, idx) => {
    if (f.units.k !== CONVENTIONS.K_CONVENTION) {
      throw new Error(`Fixture ${idx}: Non-canonical k convention: ${f.units.k}`);
    }
    if (f.param_family !== CONVENTIONS.SVI_FAMILY) {
      throw new Error(`Fixture ${idx}: Non-canonical SVI family: ${f.param_family}`);
    }
  });

  const diagnostics = {
    timestamp: new Date().toISOString(),
    fixtureHash: agg.hash,
    conventions: CONVENTIONS,
    totalFixtures: agg.fixtures.length,
    totalPoints: 0,
    ivChecks: 0,
    wChecks: 0,
    passed: 0,
    failed: 0,
    worstIV: { errorBps: 0, fixture: -1, strike: 0, expected: 0, got: 0, F: 0, K: 0, T: 0 },
    worstW: { errorBps: 0, fixture: -1, strike: 0, expected: 0, got: 0, F: 0, K: 0, T: 0 },
    failures: [] as any[],
    sviValidations: [] as any[],
  };

  // Validate SVI params
  agg.fixtures.forEach((f, idx) => {
    const validation = validateSVIParams(f.svi);
    diagnostics.sviValidations.push({
      fixture: idx,
      fixtureId: f.fixtureId ?? `idx_${idx}`,
      valid: validation.valid,
      errors: validation.errors,
    });
    if (!validation.valid) {
      console.warn(`⚠️  Fixture ${idx}: Invalid SVI:\n${validation.errors.join("\n")}`);
    }
  });

  // GATE: Fixtures must be self-consistent (SVI params match marketIV)
  it("Fixtures self-consistent: marketIV vs SVI ≤5 vol-bp", () => {
    agg.fixtures.forEach((f, idx) => {
      const ivModel = f.strikes.map(K => {
        const k = kRel(f.forward, K);
        return sviIV(k, f.T, f.svi);
      });
      const errBps = rmse(ivModel, f.marketIV) * 1e4;
      expect(errBps).toBeLessThanOrEqual(5);
    });
  });

  agg.fixtures.forEach((f, idx) => {
    const fixtureId = f.fixtureId ?? `F${f.forward}_T${f.T}`;

    describe(`Fixture ${idx}: ${fixtureId}`, () => {
      f.strikes.forEach((K, j) => {
        it(`Strike ${K}`, () => {
          diagnostics.totalPoints++;

          const k = kRel(f.forward, K);
          const iv = sviIV(k, f.T, f.svi);
          const w = sviTotalVariance(k, f.svi);

          // IV check
          if (f.marketIV && Number.isFinite(f.marketIV[j])) {
            diagnostics.ivChecks++;
            const expIV = f.marketIV[j];
            const absErrBps = Math.abs(iv - expIV) * 1e4;
            const tolBps = Math.max(IV_TOL_MIN_BPS, Math.min(IV_TOL_MAX_BPS, IV_TOL_PCT * expIV * 1e4));

            if (absErrBps > diagnostics.worstIV.errorBps) {
              diagnostics.worstIV = { errorBps: absErrBps, fixture: idx, strike: K, expected: expIV, got: iv, F: f.forward, K, T: f.T };
            }

            if (absErrBps > tolBps) {
              diagnostics.failed++;
              diagnostics.failures.push({ fixtureId, fixture: idx, strike: K, type: "IV", expected: expIV, got: iv, errorBps: absErrBps, threshold: tolBps });
            } else {
              diagnostics.passed++;
            }
            
            expect(absErrBps).toBeLessThanOrEqual(tolBps);
          }

          // W check
          if (f.marketW && Number.isFinite(f.marketW[j])) {
            diagnostics.wChecks++;
            const expW = f.marketW[j];
            const absErr = Math.abs(w - expW);
            const relErr = absErr / Math.max(1e-10, Math.abs(expW));
            const relErrBps = relErr * 1e4;
            const pass = relErrBps <= W_TOL_REL_BPS || absErr <= EPS_W_ABS;

            if (relErrBps > diagnostics.worstW.errorBps) {
              diagnostics.worstW = { errorBps: relErrBps, fixture: idx, strike: K, expected: expW, got: w, F: f.forward, K, T: f.T };
            }

            if (!pass) {
              diagnostics.failed++;
              diagnostics.failures.push({ fixtureId, fixture: idx, strike: K, type: "W", expected: expW, got: w, errorBps: relErrBps });
            } else {
              diagnostics.passed++;
            }

            expect(pass).toBe(true);
          }
        });
      });
    });
  });

  afterAll(() => {
    fs.mkdirSync(path.dirname(DIAG_PATH), { recursive: true });
    fs.writeFileSync(DIAG_PATH, JSON.stringify(diagnostics, null, 2));

    // FIXED: Correct pass rate calculation
    const totalChecks = diagnostics.ivChecks + diagnostics.wChecks;
    const passRate = totalChecks ? diagnostics.passed / totalChecks : 1;

    console.log("\n" + "=".repeat(70));
    console.log("CC PARITY - UNIT WALL ENFORCED");
    console.log("=".repeat(70));
    console.log(`Conventions: k=${CONVENTIONS.K_CONVENTION}, family=${CONVENTIONS.SVI_FAMILY}`);
    console.log(`Fixture hash: ${diagnostics.fixtureHash?.slice(0, 16)}...`);
    console.log(`Total checks: ${totalChecks} (IV: ${diagnostics.ivChecks}, W: ${diagnostics.wChecks})`);
    console.log(`Pass rate: ${(passRate * 100).toFixed(2)}%`);
    console.log(`Worst IV: ${diagnostics.worstIV.errorBps.toFixed(2)} vol-bp`);
    console.log(`Worst W: ${diagnostics.worstW.errorBps.toFixed(2)} bp`);
    console.log("=".repeat(70));
  });

  it("Pass rate ≥99%", () => {
    const totalChecks = diagnostics.ivChecks + diagnostics.wChecks;
    const passRate = totalChecks ? diagnostics.passed / totalChecks : 1;
    expect(passRate).toBeGreaterThanOrEqual(0.99);
  });

  it("Worst IV ≤5 vol-bp", () => {
    expect(diagnostics.worstIV.errorBps).toBeLessThanOrEqual(IV_TOL_MAX_BPS);
  });

  it("No invalid SVI", () => {
    expect(diagnostics.sviValidations.filter(v => !v.valid).length).toBe(0);
  });

  it("Diagnostics: pass-rate computed against total checks", () => {
    const totalChecks = diagnostics.ivChecks + diagnostics.wChecks;
    expect(diagnostics.totalPoints).toBeLessThanOrEqual(totalChecks);
  });
});
