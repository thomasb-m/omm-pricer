import { convexityPenaltyK } from "./penalty.js";
export function staticNoArbDiagnostics(k, tv, eps = 0) {
    const { penalty, violations } = convexityPenaltyK(k, tv, eps);
    return { violations, penalty };
}
//# sourceMappingURL=noarb.js.map