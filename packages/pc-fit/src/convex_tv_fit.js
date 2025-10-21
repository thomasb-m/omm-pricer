import { sanitizeLegs } from './sanitize.js';
import { taperAbsK } from './interp.js';
import { baseWeights, applyTrimBps } from './weights.js';
import { huberWeights, tukeyWeights } from './robust.js';
import { convexRepair, projectThetaByCallConvexity } from './guards.js';
export function fitConvexTV(input) {
    const { legs, forward, ccTV, phi, options } = input;
    const san = sanitizeLegs(legs, forward);
    const n = san.legs.length;
    const ccTVVec = san.indices.map(i => ccTV[i]);
    const phiVec = san.indices.map(i => phi[i]);
    const mktTV = san.legs.map(l => Math.max(l.marketMid, 0));
    const target = ccTVVec.map((cc, i) => mktTV[i] - cc);
    const taper = taperAbsK(san.k, options.taperBand ?? 0.25, options.taperExp ?? 1.0);
    const w0 = baseWeights(san.legs, phiVec, ccTVVec, options);
    const usedInit = w0.map(w => w > 0);
    const usedCount = usedInit.filter(Boolean).length;
    if (usedCount < 5) {
        return {
            theta: 0,
            tvFitted: ccTVVec.slice(),
            w0,
            wFinal: w0.slice(),
            usedMask: usedInit,
            usedCount,
            rmseBps: 0,
            degenerate: true,
            metadata: { irlsIters: 0, thetaShrinkCount: 0, trimmedCount: 0, minTVSlack: 0 }
        };
    }
    if (phiVec.every(p => p === 0)) {
        const floorVec = buildFloors(san.legs, ccTVVec, taper, options);
        const tvFitted = convexRepair(san.legs.map(l => l.strike), ccTVVec, floorVec);
        return {
            theta: 0,
            tvFitted,
            w0,
            wFinal: w0.slice(),
            usedMask: usedInit,
            usedCount,
            rmseBps: 0,
            degenerate: false,
            metadata: { irlsIters: 0, thetaShrinkCount: 0, trimmedCount: 0, minTVSlack: 0 }
        };
    }
    let theta = solveWLS(target, taper, w0);
    let resid = target.map((t, i) => t - theta * taper[i]);
    const prelim = mktTV.map(() => true);
    let wr = w0.map(() => 1);
    let irlsIters = 0;
    const maxIters = 5;
    for (let iter = 0; iter < maxIters; iter++) {
        irlsIters++;
        const wEff = w0.map((w, i) => w * wr[i] * (prelim[i] ? 1 : 0));
        theta = solveWLS(target, taper, wEff);
        resid = target.map((t, i) => t - theta * taper[i]);
        const wrNew = options.robustLoss === 'tukey'
            ? tukeyWeights(resid, wEff, options.tukeyC ?? 4.685)
            : huberWeights(resid, wEff, options.huberC ?? 1.345);
        const maxDiff = wr.reduce((acc, w, i) => Math.max(acc, Math.abs(w - wrNew[i])), 0);
        wr = wrNew;
        if (maxDiff < 1e-4)
            break;
    }
    const wEffFinal = w0.map((w, i) => w * wr[i] * (prelim[i] ? 1 : 0));
    const secondTrim = applyTrimBps(resid, wEffFinal, options.maxOutlierTrimBps ?? 0);
    const wFinal = w0.map((w, i) => w * wr[i] * (prelim[i] ? 1 : 0) * (secondTrim[i] ? 1 : 0));
    theta = solveWLS(target, taper, wFinal);
    let shrinkCount = 0;
    if (options.enforceCallConvexity) {
        const proj = projectThetaByCallConvexity(theta, san.legs.map(l => l.strike), forward, ccTVVec, taper, options.convexityTol ?? 1e-6);
        theta = proj.theta;
        shrinkCount = proj.shrinkCount;
    }
    const tvRaw = ccTVVec.map((cc, i) => cc + theta * taper[i]);
    const floorVec = buildFloors(san.legs, ccTVVec, taper, options);
    const tvFitted = convexRepair(san.legs.map(l => l.strike), tvRaw, floorVec);
    const used = wFinal.map(w => w > 0);
    let bpsSumSq = 0, bpsN = 0;
    for (let i = 0; i < n; i++) {
        if (!used[i])
            continue;
        const err = tvFitted[i] - mktTV[i];
        const scale = Math.max(mktTV[i], 5 * options.minTick);
        const bps = (err / Math.max(scale, 1e-12)) * 1e4;
        bpsSumSq += bps * bps;
        bpsN++;
    }
    const rmseBps = bpsN > 0 ? Math.sqrt(bpsSumSq / bpsN) : 0;
    const minTVSlack = Math.min(...tvFitted.map((tv, i) => tv - floorVec[i]));
    const trimmedCount = usedInit.filter(Boolean).length - used.filter(Boolean).length;
    return {
        theta,
        tvFitted,
        w0,
        wFinal,
        usedMask: used,
        usedCount: used.filter(Boolean).length,
        rmseBps,
        degenerate: false,
        metadata: { irlsIters, thetaShrinkCount: shrinkCount, trimmedCount, minTVSlack }
    };
}
function solveWLS(target, X, w) {
    let num = 0, den = 0;
    for (let i = 0; i < target.length; i++) {
        if (w[i] > 0) {
            num += w[i] * X[i] * target[i];
            den += w[i] * X[i] * X[i];
        }
    }
    return den > 1e-12 ? num / den : 0;
}
function buildFloors(legs, ccTV, taper, options) {
    const { minTick, minTVTicks, minTVFracOfCC, applyTickFloorWithinBand = true, minTVAbsFloorTicks = 1 } = options;
    const absFloor = minTVAbsFloorTicks * minTick;
    return legs.map((_, i) => {
        const inBand = (taper[i] > 0) || !applyTickFloorWithinBand;
        const tickFloor = inBand ? minTVTicks * minTick : 0;
        const fracFloor = minTVFracOfCC * ccTV[i];
        return Math.max(absFloor, tickFloor, fracFloor);
    });
}
//# sourceMappingURL=convex_tv_fit.js.map