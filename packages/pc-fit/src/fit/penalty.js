export function convexityPenaltyK(k, tv, eps = 0) {
    const n = Math.min(k.length, tv.length);
    if (n < 3)
        return { penalty: 0, violations: 0 };
    const idx = [...Array(n).keys()].sort((a, b) => k[a] - k[b]);
    const kk = idx.map(i => k[i]);
    const vv = idx.map(i => tv[i]);
    let penalty = 0;
    let violations = 0;
    for (let i = 1; i < n - 1; i++) {
        const h1 = kk[i] - kk[i - 1];
        const h2 = kk[i + 1] - kk[i];
        if (h1 <= 0 || h2 <= 0)
            continue;
        const d2 = 2 * ((vv[i + 1] - vv[i]) / h2 - (vv[i] - vv[i - 1]) / h1) / (h1 + h2);
        if (d2 < -eps) {
            violations++;
            penalty += (-d2 - eps);
        }
    }
    return { penalty, violations };
}
//# sourceMappingURL=penalty.js.map