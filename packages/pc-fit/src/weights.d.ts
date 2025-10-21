import { Leg, FitOptions } from './types.js';
export declare function baseWeights(legs: Leg[], phi: number[], ccTV: number[], options: FitOptions): number[];
export declare function trimByTVBps(resid: number[], mktTV: number[], minTick: number, maxBps?: number): boolean[];
export declare function applyTrimBps(resid: number[], w0: number[], maxBps: number): boolean[];
//# sourceMappingURL=weights.d.ts.map