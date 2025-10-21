"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const risk_1 = require("../../risk");
describe("black76Greeks", () => {
    const F = 100_000;
    const T = 0.25; // 3 months
    const df = 1;
    test("finite outputs for reasonable inputs (call)", () => {
        const g = (0, risk_1.black76Greeks)(F, F, T, 0.3, true, df);
        for (const [k, v] of Object.entries(g)) {
            expect(Number.isFinite(v)).toBe(true);
        }
    });
    test("finite outputs for reasonable inputs (put)", () => {
        const g = (0, risk_1.black76Greeks)(F, F, T, 0.3, false, df);
        for (const [k, v] of Object.entries(g)) {
            expect(Number.isFinite(v)).toBe(true);
        }
    });
    test("call price increases with vol", () => {
        const p1 = (0, risk_1.black76Greeks)(F, F, T, 0.1, true, df).price;
        const p2 = (0, risk_1.black76Greeks)(F, F, T, 0.4, true, df).price;
        expect(p2).toBeGreaterThan(p1);
    });
    test("put price increases with vol", () => {
        const p1 = (0, risk_1.black76Greeks)(F, F, T, 0.1, false, df).price;
        const p2 = (0, risk_1.black76Greeks)(F, F, T, 0.4, false, df).price;
        expect(p2).toBeGreaterThan(p1);
    });
    test("deep OTM call ~ small", () => {
        const p = (0, risk_1.black76Greeks)(F, F * 10, T, 0.3, true, df).price;
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(1e-3 * F); // tiny vs forward
    });
});
