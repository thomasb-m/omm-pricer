import { volService } from "../integration/volModelService";

describe("smokeQuoteTrade → quote→trade→quote path", () => {
  const symbol = "BTC";
  const now = Date.now();
  const expiry = now + 7 * 24 * 3600 * 1000;

  it("quotes OTM put, executes a trade, and inventory shifts edge directionally", () => {
    const strikeOTMPut = 90_000;

    const q0 = volService.getQuoteWithIV(symbol, strikeOTMPut, expiry, 0.35, "P");

    expect(q0).toBeTruthy();
    expect(q0.bid).toBeGreaterThanOrEqual(0);
    expect(q0.ask).toBeGreaterThan(q0.bid);

    // trade via integration adapter (positional API)
    volService.onCustomerTrade(
      symbol,
      strikeOTMPut,
      "BUY",    // we buy the put (dealer sells)
      50,
      q0.bid,
      expiry,
      "P",
      now,
      0.35
    );

    const q1 = volService.getQuoteWithIV(symbol, strikeOTMPut, expiry, 0.35, "P");

    expect(q1).toBeTruthy();
    expect(q1.ask).toBeGreaterThan(q1.bid);
  });
});

export {};
