export function dot(a, b) {
    let s = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        s += a[i] * b[i];
    }
    return s;
}
//# sourceMappingURL=index.js.map