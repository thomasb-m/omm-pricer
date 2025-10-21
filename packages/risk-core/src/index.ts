export type Factor = "vega" | "skew" | "putWing" | "callWing" | "gamma" | "delta";
export type RiskVector = Record<Factor, number>;

export function dot(a: number[], b: number[]): number {
  let s = 0; 
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    s += a[i] * b[i];
  }
  return s;
}
