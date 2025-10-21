export function applyATMPin(k, tv, { pinStrength = 0.2 } = {}) {
    const out = [...tv];
    const idx = k.map((v, i) => [Math.abs(v), i]).sort((a, b) => a[0] - b[0]).slice(0, 3).map(x => x[1]);
    const avg = idx.reduce((s, i) => s + tv[i], 0) / Math.max(1, idx.length);
    for (const i of idx)
        out[i] = (1 - pinStrength) * tv[i] + pinStrength * avg;
    return out;
}
export function applySoftFloors(tv, { floor = 0 } = {}) {
    return tv.map(v => (v < floor ? 0.5 * (v + floor) : v));
}
//# sourceMappingURL=regularize.js.map