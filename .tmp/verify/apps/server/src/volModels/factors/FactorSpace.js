"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZeroFactors = void 0;
exports.dot = dot;
exports.axpy = axpy;
exports.norm1 = norm1;
exports.ZeroFactors = [0, 0, 0, 0, 0, 0];
function dot(a, b) {
    let s = 0;
    for (let i = 0; i < 6; i++)
        s += a[i] * b[i];
    return s;
}
function axpy(y, a, x) {
    return [
        y[0] + a * x[0],
        y[1] + a * x[1],
        y[2] + a * x[2],
        y[3] + a * x[3],
        y[4] + a * x[4],
        y[5] + a * x[5],
    ];
}
function norm1(a) {
    return (Math.abs(a[0]) +
        Math.abs(a[1]) +
        Math.abs(a[2]) +
        Math.abs(a[3]) +
        Math.abs(a[4]) +
        Math.abs(a[5]));
}
