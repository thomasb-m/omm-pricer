export function huberWeights(resid, w0, c = 1.345) {
    const used = resid.map((_, i) => w0[i] > 0);
    const usedResid = resid.filter((_, i) => used[i]);
    if (usedResid.length === 0)
        return w0.map(() => 0);
    const abs = usedResid.map(Math.abs);
    abs.sort((a, b) => a - b);
    const med = abs[Math.floor(abs.length / 2)];
    const mad = abs.map(a => Math.abs(a - med));
    mad.sort((a, b) => a - b);
    const madVal = mad[Math.floor(mad.length / 2)];
    const sigma = Math.max(1.4826 * madVal, 1e-8);
    return resid.map((r, i) => {
        if (w0[i] <= 0)
            return 0;
        const z = Math.abs(r) / sigma;
        return z <= c ? 1 : c / z;
    });
}
export function tukeyWeights(resid, w0, c = 4.685) {
    const used = resid.map((_, i) => w0[i] > 0);
    const usedResid = resid.filter((_, i) => used[i]);
    if (usedResid.length === 0)
        return w0.map(() => 0);
    const abs = usedResid.map(Math.abs);
    abs.sort((a, b) => a - b);
    const med = abs[Math.floor(abs.length / 2)];
    const mad = abs.map(a => Math.abs(a - med));
    mad.sort((a, b) => a - b);
    const madVal = mad[Math.floor(mad.length / 2)];
    const sigma = Math.max(1.4826 * madVal, 1e-8);
    return resid.map((r, i) => {
        if (w0[i] <= 0)
            return 0;
        const z = Math.abs(r) / sigma;
        if (z >= c)
            return 0;
        const u = 1 - (z / c) ** 2;
        return u * u;
    });
}
//# sourceMappingURL=robust.js.map