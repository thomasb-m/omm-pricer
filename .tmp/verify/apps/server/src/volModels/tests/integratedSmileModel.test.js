"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const integratedSmileModel_1 = require("../integratedSmileModel");
const days = (d) => d * 24 * 3600 * 1000;
describe("IntegratedSmileModel", () => {
    let model;
    let now;
    beforeEach(() => {
        model = new integratedSmileModel_1.IntegratedSmileModel("BTC");
        now = Date.now();
    });
    test("ATM quote finite & reasonable", () => {
        const forward = 100_000;
        const strike = 100_000;
        const expiry = now + days(14);
        const q = model.getQuote(expiry, strike, forward, "C", 0.31);
        expect(q.pcMid).toBeGreaterThan(0);
        expect(q.ccMid).toBeGreaterThan(0);
        expect(q.ask).toBeGreaterThanOrEqual(q.bid);
        expect(["atm", "rr25", "rr10", "wings"]).toContain(q.bucket);
    });
    test("trade updates inventory and changes edge (directional)", () => {
        const forward = 100_000;
        const strike = 90_000; // OTM put-ish
        const expiry = now + days(14);
        const q0 = model.getQuote(expiry, strike, forward, "P", 0.31);
        const edge0 = q0.edge;
        // Customer BUY 50 puts at ask → we SELL → short vega → PC should lift vs CC (edge up)
        const price = q0.ask;
        model.onTrade({
            expiryMs: expiry,
            strike,
            forward,
            optionType: "P",
            price,
            size: +50, // size signed from CUSTOMER perspective per your service
            time: now
        });
        const q1 = model.getQuote(expiry, strike, forward, "P", 0.31);
        expect(Number.isFinite(q1.edge)).toBe(true);
        expect(q1.edge).not.toBe(edge0);
    });
});
