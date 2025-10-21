import { Leg } from './types.js';
export interface SanitizedLegs {
    legs: Leg[];
    k: number[];
    indices: number[];
}
export declare function logMoneyness(strike: number, forward: number): number;
export declare function sanitizeLegs(legs: Leg[], forward: number): SanitizedLegs;
//# sourceMappingURL=sanitize.d.ts.map