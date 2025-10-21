import { convexityPenaltyK } from "./penalty.js";

export function staticNoArbDiagnostics(k: number[], tv: number[], eps = 0) {
  const { penalty, violations } = convexityPenaltyK(k, tv, eps);
  return { violations, penalty };
}
