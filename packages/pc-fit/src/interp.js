export function taperAbsK(k, band = 0.25, p = 1.0) {
    const b = Math.max(band, 1e-12);
    return k.map(ki => {
        const r = Math.abs(ki) / b;
        return Math.max(0, 1 - Math.pow(r, p));
    });
}
export function linearInterp(x, y, xq) {
    if (xq <= x[0])
        return y[0];
    if (xq >= x[x.length - 1])
        return y[y.length - 1];
    for (let i = 0; i < x.length - 1; i++) {
        if (xq >= x[i] && xq <= x[i + 1]) {
            const t = (xq - x[i]) / (x[i + 1] - x[i]);
            return y[i] + t * (y[i + 1] - y[i]);
        }
    }
    return y[y.length - 1];
}
//# sourceMappingURL=interp.js.map