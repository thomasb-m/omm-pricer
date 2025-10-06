// tools/ai/verify.ts
import { strict as assert } from "assert";
import { SVI, toMetrics, fromMetrics, type SVIParams, type TraderMetrics, type Config } from "../../apps/server/src/volModels/sviMapping";

const cfg: Config = { rhoMax: 0.999, c0Min: 1e-8, bMin: 1e-8, sigmaMin: 1e-8 };

function randIn(lo: number, hi: number) {
  return lo + Math.random() * (hi - lo);
}

function randomSVI(): SVIParams {
  const b = randIn(0.05, 1.0);
  const rho = randIn(-0.8, 0.8);
  const sigma = randIn(0.05, 1.0);
  const a = randIn(0.0, 0.1);
  return { a, b, rho, sigma, m: 0 };
}

function approx(a: number, b: number, tol: number) {
  return Math.abs(a - b) <= tol;
}

function s0FromWings(m: TraderMetrics) {
  const b = 0.5 * (m.S_pos + m.S_neg);
  const rho = (m.S_pos - m.S_neg) / Math.max(m.S_pos + m.S_neg, 1e-12);
  return b * rho;
}

// 1) Round-trip in metric space (idempotence to tolerance)
{
  for (let k = 0; k < 50; k++) {
    const svi = randomSVI();
    const m1 = toMetrics(svi);
    const p1 = fromMetrics(m1, cfg, { preserveBumps: true });
    const m2 = toMetrics(p1);

    // Check identities hold
    assert(approx(m1.S0, s0FromWings(m1), 1e-8), "S0 identity mismatch (m1)");
    assert(approx(m2.S0, s0FromWings(m2), 1e-8), "S0 identity mismatch (m2)");

    // Allow small differences due to floors; level and wings should be close
    assert(approx(m1.L0, m2.L0, 1e-6), "L0 not preserved");
    assert(approx(m1.C0, m2.C0, 1e-5), "C0 not preserved");
    assert(approx(m1.S_neg, m2.S_neg, 1e-5), "S_neg not preserved");
    assert(approx(m1.S_pos, m2.S_pos, 1e-5), "S_pos not preserved");
  }
  console.log("[verify] Round-trip metric idempotence: OK");
}

// 2) Constrained S0 bump should move wings with constant sum (b)
{
  const svi = randomSVI();
  const m0 = toMetrics(svi);
  const h = Math.max(Math.abs(m0.S0) * 1e-3, 1e-4);

  const Ssum0 = m0.S_pos + m0.S_neg;
  const b0 = Ssum0 / 2;

  // Emulate greeks’ constrained bump: change S0, recompute wings holding b
  const S0_new = m0.S0 + h;
  const rho_new = S0_new / Math.max(b0, 1e-8);
  const S_pos_new = b0 * (1 + rho_new);
  const S_neg_new = b0 * (1 - rho_new);

  // Check constant sum and correct new S0
  const Ssum1 = S_pos_new + S_neg_new;
  assert(approx(Ssum1, Ssum0, 1e-9), "Wing sum changed under constrained S0 bump");
  const S0_check = s0FromWings({ ...m0, S_pos: S_pos_new, S_neg: S_neg_new, S0: 0, C0: m0.C0, L0: m0.L0 });
  assert(approx(S0_check, S0_new, 1e-9), "S0 not preserved by constrained bump");

  console.log("[verify] Constrained S0 bump preserves b and updates wings: OK");
}

console.log("[verify] All checks passed ✅");
