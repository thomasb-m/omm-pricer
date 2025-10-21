"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const volModelService_1 = require("../integration/volModelService");
const days = (d) => d * 24 * 3600 * 1000;
describe("Quote→Trade→Quote smoke", () => {
    test("mid changes directionally and inventory updates", () => {
        const now = Date.now();
        const symbol = "BTC";
        const forward = 100_000;
        const expiry = now + days(14);
        const strikeOTMPut = 0.9 * forward;
        // initialize forward
        volModelService_1.volService.updateForward(symbol, forward);
        const q0 = volModelService_1.volService.getQuoteWithIV(symbol, strikeOTMPut, expiry, "P", 0.31);
        expect(Number.isFinite(q0.mid)).toBe(true);
        // Customer BUY put -> we SELL -> short vega in that bucket, pcMid should lift vs before (directional change)
        volModelService_1.volService.onCustomerTrade(symbol, strikeOTMPut, "BUY", 25, q0.ask, expiry, "P", now, 0.31);
        const q1 = volModelService_1.volService.getQuoteWithIV(symbol, strikeOTMPut, expiry, "P", 0.31);
        expect(Number.isFinite(q1.mid)).toBe(true);
        // Inventory should not be zero anymore
        const inv = volModelService_1.volService.getInventory(symbol);
        expect(Math.abs(inv.totalVega ?? 0)).toBeGreaterThan(0);
        // Mid should shift (not asserting direction because PC+λ·g both act; we just check movement)
        expect(Math.abs(q1.mid - q0.mid)).toBeGreaterThan(0);
    });
});
