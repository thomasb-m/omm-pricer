import { volService } from "../integration/volModelService";

describe("volModelService λ·g influence", () => {
  test("changing lambda shifts quoted mid", () => {
    const now = Date.now();
    const expiry = now + 14*24*3600*1000;
    const strike = 100_000;

    // Baseline mid
    const q0 = volService.getQuoteWithIV("BTC", strike, expiry, "C", 0.31);
    expect(Number.isFinite(q0.mid)).toBe(true);

    // Strong lambda on L0: amplify sensitivity
    volService.setLambda("BTC", [2.0, 0, 0, 0, 0, 0]);
    const q1 = volService.getQuoteWithIV("BTC", strike, expiry, "C", 0.31);
    expect(Number.isFinite(q1.mid)).toBe(true);

    // Revert lambda so other tests remain stable
    volService.setLambda("BTC", [0.50, 0.20, 0.10, 0.15, 0.10, 0.30]);

    // λ·g should move mid
    expect(Math.abs(q1.mid - q0.mid)).toBeGreaterThan(0);
  });
});
