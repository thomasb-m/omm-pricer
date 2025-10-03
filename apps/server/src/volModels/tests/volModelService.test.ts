import { volService } from "../integration/volModelService";

describe("volModelService.getQuoteWithIV", () => {
  test("returns finite quote for normal inputs", () => {
    const now = Date.now();
    const res = volService.getQuoteWithIV("BTC", 100_000, now + 14*24*3600*1000, "C", 0.31);
    expect(Number.isFinite(res.mid)).toBe(true);
    expect(res.spread).toBeGreaterThanOrEqual(0);
    expect(res.bid).toBeGreaterThanOrEqual(0);
    expect(res.ask).toBeGreaterThanOrEqual(res.bid);
  });

  test("gracefully handles swapped strike/expiry (bogus order)", () => {
    const now = Date.now();
    const expiryMs = now + 7*24*3600*1000;
    const bogusStrike = expiryMs;  // looks like ms timestamp
    const res = volService.getQuoteWithIV("BTC", bogusStrike, 100_000, "P", 0.31);
    expect(Number.isFinite(res.mid)).toBe(true);
    expect(res.spread).toBeGreaterThanOrEqual(0);
  });
});
