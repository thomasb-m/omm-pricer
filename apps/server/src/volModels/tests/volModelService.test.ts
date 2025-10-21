import { volService } from "../integration/volModelService";

describe("VolModelService basic functionality", () => {
  const symbol = "BTC";
  const now = Date.now();
  const expiry = now + 7 * 24 * 3600 * 1000;

  it("gets a quote with valid prices", () => {
    const strike = 95_000;
    // positional API: getQuoteWithIV(symbol, strike, expiryMs, ivGuessOrFwd, "P"|"C")
    const q = volService.getQuoteWithIV(symbol, strike, expiry, 0.35, "P");

    expect(q).toBeTruthy();
    expect(q.bid).toBeGreaterThanOrEqual(0);
    expect(q.ask).toBeGreaterThan(q.bid);
    expect(Number.isFinite(q.mid)).toBe(true);
  });
});

export {};
