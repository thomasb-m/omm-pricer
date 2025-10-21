"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const blackScholes_1 = require("../pricing/blackScholes");
describe("DeltaConventions.strikeToBucket", () => {
    const spot = 100;
    const T = 0.25;
    const iv = 0.31;
    test("ATM falls into atm bucket", () => {
        const b = blackScholes_1.DeltaConventions.strikeToBucket(100, spot, iv, T);
        expect(b).toBe("atm");
    });
    test("OTM put is not atm", () => {
        const b = blackScholes_1.DeltaConventions.strikeToBucket(90, spot, iv, T);
        expect(b).not.toBe("atm");
    });
});
