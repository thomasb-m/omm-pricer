"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParametricSurface = void 0;
// Basis functions (smooth bumps in moneyness space)
function gaussianBump(m, center, width) {
    return Math.exp(-Math.pow((m - center) / width, 2) / 2);
}
class ParametricSurface {
    // Delta to moneyness mapping (approximate for given TTX and vol)
    deltaToMoneyness(delta, vol, ttx) {
        // For puts: delta is negative, for calls: positive
        // Approximate: m ≈ -vol * sqrt(ttx) * N^(-1)(|delta|)
        const absDelta = Math.abs(delta);
        const z = this.inverseNormal(absDelta);
        return -Math.sign(delta - 0.5) * vol * Math.sqrt(ttx) * z;
    }
    inverseNormal(p) {
        // Approximate inverse normal CDF for delta->moneyness
        if (p <= 0 || p >= 1)
            return 0;
        const a = [2.515517, 0.802853, 0.010328];
        const b = [1.432788, 0.189269, 0.001308];
        const t = Math.sqrt(-2 * Math.log(Math.min(p, 1 - p)));
        const num = a[0] + t * (a[1] + t * a[2]);
        const den = 1 + t * (b[0] + t * (b[1] + t * b[2]));
        return (p > 0.5 ? 1 : -1) * (t - num / den);
    }
    getIV(moneyness, params) {
        const { vol, skew, pump, wingPut, wingCall } = params;
        // Base quadratic in moneyness
        const base = vol + 0.5 * vol * moneyness * moneyness;
        // Skew component (max at ±25Δ ≈ ±0.15 moneyness for typical vol/ttx)
        const skewBump = skew * moneyness * gaussianBump(moneyness, 0, 0.2);
        // Pump component (symmetric at ±15Δ ≈ ±0.25 moneyness)
        const pumpBump = pump * (gaussianBump(moneyness, -0.25, 0.15) +
            gaussianBump(moneyness, 0.25, 0.15));
        // Wing components (10Δ ≈ ±0.35 moneyness)
        const putWingBump = wingPut * gaussianBump(moneyness, -0.35, 0.15);
        const callWingBump = wingCall * gaussianBump(moneyness, 0.35, 0.15);
        return base + skewBump + pumpBump + putWingBump + callWingBump;
    }
    calibrate(strikes, ivs, spot) {
        const moneynesses = strikes.map(k => Math.log(k / spot));
        // ATM vol (closest to moneyness = 0)
        const atmIdx = moneynesses.reduce((prev, curr, idx) => Math.abs(curr) < Math.abs(moneynesses[prev]) ? idx : prev, 0);
        const vol = ivs[atmIdx];
        // Find deep OTM put (most negative moneyness)
        const putIdx = moneynesses.reduce((minIdx, curr, idx) => curr < moneynesses[minIdx] ? idx : minIdx, 0);
        // Find deep OTM call (most positive moneyness)
        const callIdx = moneynesses.reduce((maxIdx, curr, idx) => curr > moneynesses[maxIdx] ? idx : maxIdx, 0);
        // Skew: difference between put wing and call wing IVs
        const skew = putIdx !== callIdx
            ? (ivs[putIdx] - ivs[callIdx]) * 0.5 // Scale down because basis function amplifies
            : 0;
        console.log(`Calibration: ATM=${vol.toFixed(4)}, Put IV=${ivs[putIdx].toFixed(4)} at m=${moneynesses[putIdx].toFixed(3)}, Call IV=${ivs[callIdx].toFixed(4)} at m=${moneynesses[callIdx].toFixed(3)}, Skew=${skew.toFixed(4)}`);
        return { vol, skew, pump: 0, wingPut: 0, wingCall: 0, volPathRate: 0 };
    }
    reprice(strikes, spot, params) {
        return strikes.map(k => {
            const m = Math.log(k / spot);
            return this.getIV(m, params);
        });
    }
}
exports.ParametricSurface = ParametricSurface;
