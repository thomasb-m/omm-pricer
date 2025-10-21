// tools/ai/verify.ts
// Harness write test — ok
//change
import { strict as assert } from "assert";
import * as sviNS from "../../apps/server/src/volModels/sviMapping";

// Support both named exports and default-only exports (CJS interop)
const M: any = sviNS as any;
const get = (k: string) => M[k] ?? M.default?.[k];
const SVI = get("SVI");
const toMetrics = get("toMetrics");
const fromMetrics = get("fromMetrics");
const s0FromWings = get("s0FromWings");

const approx = (a: number, b: number, eps = 1e-9) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

function randomSVI() {
  const a = Math.random() * 0.2 + 0.02;
  const b = Math.random() * 5 + 0.5;
  const rho = Math.max(-0.999, Math.min(0.999, (Math.random() * 2 - 1) * 0.9));
  const m = Math.random() * 0.6 - 0.3;
  const sigma = Math.random() * 0.6 + 0.05;
  return { a, b, rho, m, sigma };
}

(async function main() {
  console.log("[verify] Node:", process.version);
  console.log("[verify] CWD:", process.cwd());

  assert(typeof SVI === "object", "SVI export missing");
  assert(typeof toMetrics === "function", "toMetrics export missing");
  assert(typeof fromMetrics === "function", "fromMetrics export missing");
  console.log("[verify] Exports: OK");

  const sviObj = randomSVI();
  const m0 = toMetrics(sviObj);
  const svi2 = fromMetrics(m0, {});
  const m1 = toMetrics(svi2);
  assert(approx(m0.S0, m1.S0, 1e-8));
  console.log("[verify] Round-trip metric idempotence: OK");

  const h = Math.max(Math.abs(m0.S0) * 1e-3, 1e-4);
  const Ssum0 = m0.S_pos + m0.S_neg;
  const b0 = Ssum0 / 2;
  const S0_new = m0.S0 + h;
  const rho_new = S0_new / Math.max(b0, 1e-8);
  const S_pos_new = b0 * (1 + rho_new);
  const S_neg_new = b0 * (1 - rho_new);
  const Ssum1 = S_pos_new + S_neg_new;
  assert(approx(Ssum1, Ssum0, 1e-9));

  const S0_check = s0FromWings({
    ...m0,
    S_pos: S_pos_new,
    S_neg: S_neg_new,
    S0: 0,
    C0: m0.C0,
    L0: m0.L0,
  });
  assert(approx(S0_check, S0_new, 1e-9));
  console.log("[verify] Constrained S0 bump preserves b and updates wings: OK");

  console.log("[verify] All checks passed ✅");
})().catch((err) => {
  console.error("[verify] FAILED:", err);
  process.exit(1);
});
