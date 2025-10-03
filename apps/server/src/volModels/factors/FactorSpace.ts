/**
 * FactorSpace — types + helpers for factor calculus
 * Factors: [L0, S0, C0, S_neg, S_pos, F]
 */
export type FactorVec = [number, number, number, number, number, number];
export const ZeroFactors: FactorVec = [0, 0, 0, 0, 0, 0];

export function dot(a: FactorVec, b: FactorVec): number {
  let s = 0;
  for (let i = 0; i < 6; i++) s += a[i] * b[i];
  return s;
}

export function axpy(y: FactorVec, a: number, x: FactorVec): FactorVec {
  return [
    y[0] + a * x[0],
    y[1] + a * x[1],
    y[2] + a * x[2],
    y[3] + a * x[3],
    y[4] + a * x[4],
    y[5] + a * x[5],
  ];
}

export function norm1(a: FactorVec): number {
  return (
    Math.abs(a[0]) +
    Math.abs(a[1]) +
    Math.abs(a[2]) +
    Math.abs(a[3]) +
    Math.abs(a[4]) +
    Math.abs(a[5])
  );
}
