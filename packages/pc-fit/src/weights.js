export function baseWeights(legs, phi, ccTV, options) {
    const kappa = 2.0;
    const delta = 0.1;
    return legs.map((leg, i) => {
        if (phi[i] <= 0)
            return 0;
        let scale;
        if (leg.vega != null && leg.vega > 0) {
            const vegaScale = kappa * leg.vega * 0.0001;
            const tvScale = delta * 0.0001 * ccTV[i];
            scale = Math.max(vegaScale, tvScale);
        }
        else {
            scale = Math.max(0.0001 * ccTV[i], 1e-6);
        }
        const w = (leg.weight ?? 1) * phi[i];
        return w / (scale * scale);
    });
}
export function trimByTVBps(resid, mktTV, minTick, maxBps) {
    if (!maxBps || maxBps <= 0)
        return resid.map(() => true);
    return resid.map((r, i) => {
        const scale = Math.max(mktTV[i], 5 * minTick);
        const bps = Math.abs(r) / Math.max(scale, 1e-12) * 1e4;
        return bps <= maxBps;
    });
}
export function applyTrimBps(resid, w0, maxBps) {
    if (!Number.isFinite(maxBps) || maxBps <= 0) {
        return resid.map(() => true);
    }
    const used = resid.map((r, i) => w0[i] > 0);
    const usedResid = resid.filter((_, i) => used[i]);
    if (usedResid.length === 0)
        return used;
    const abs = usedResid.map(Math.abs);
    abs.sort((a, b) => a - b);
    const med = abs[Math.floor(abs.length / 2)];
    const mad = abs.map(a => Math.abs(a - med));
    mad.sort((a, b) => a - b);
    const madVal = mad[Math.floor(mad.length / 2)];
    const sigma = 1.4826 * madVal;
    const tol = Math.max(maxBps * 0.0001, 3 * sigma);
    return resid.map((r, i) => used[i] && Math.abs(r) <= tol);
}
//# sourceMappingURL=weights.js.map