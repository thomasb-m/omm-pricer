function huberWeight(r, c) {
    const a = Math.abs(r);
    return a <= c ? 1 : c / a;
}
function tukeyWeight(r, c) {
    const a = Math.abs(r);
    if (a >= c)
        return 0;
    const u = 1 - (a * a) / (c * c);
    return u * u;
}
/** Weighted least squares for y ~ beta0 + beta1 * x */
function wlsStep(x, y, w) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < x.length; i++) {
        const wi = w[i];
        sw += wi;
        sx += wi * x[i];
        sy += wi * y[i];
        sxx += wi * x[i] * x[i];
        sxy += wi * x[i] * y[i];
    }
    const denom = sw * sxx - sx * sx;
    if (denom === 0) {
        const n = x.length;
        let mx = 0, my = 0;
        for (let i = 0; i < n; i++) {
            mx += x[i];
            my += y[i];
        }
        mx /= n;
        my /= n;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) {
            num += (x[i] - mx) * (y[i] - my);
            den += (x[i] - mx) * (x[i] - mx);
        }
        const b1 = den === 0 ? 0 : num / den;
        const b0 = my - b1 * mx;
        return { b0, b1 };
    }
    const b1 = (sw * sxy - sx * sy) / denom;
    const b0 = (sy - b1 * sx) / sw;
    return { b0, b1 };
}
/** IRLS with Huber/Tukey weights */
export function irls(x, y, opts = {}) {
    if (x.length !== y.length)
        throw new Error("x/y length mismatch");
    const n = x.length;
    const kind = opts.kind ?? "huber";
    const c = opts.c ?? (kind === "huber" ? 1.345 : 4.685);
    const maxIter = opts.maxIter ?? 25;
    const tol = opts.tol ?? 1e-9;
    let w = Array(n).fill(1);
    let { b0, b1 } = wlsStep(x, y, w);
    let it = 0;
    for (; it < maxIter; it++) {
        const r = y.map((yy, i) => yy - (b0 + b1 * x[i]));
        const med = (arr) => {
            const v = [...arr].sort((a, b) => a - b);
            const m = Math.floor(v.length / 2);
            return v.length % 2 ? v[m] : 0.5 * (v[m - 1] + v[m]);
        };
        const m = med(r);
        const mad = med(r.map(v => Math.abs(v - m))) || 1e-12;
        const scale = 1.4826 * mad || 1;
        for (let i = 0; i < n; i++) {
            const ri = r[i] / (scale || 1);
            if (kind === "huber")
                w[i] = huberWeight(ri, c);
            else
                w[i] = tukeyWeight(ri, c);
            if (!isFinite(w[i]))
                w[i] = 0;
        }
        const prev0 = b0, prev1 = b1;
        ({ b0, b1 } = wlsStep(x, y, w));
        const diff = Math.abs(b0 - prev0) + Math.abs(b1 - prev1);
        if (diff < tol)
            break;
    }
    const residuals = y.map((yy, i) => yy - (b0 + b1 * x[i]));
    return { beta0: b0, beta1: b1, weights: w, residuals, iters: it };
}
//# sourceMappingURL=robust.js.map