export interface Leg {
    strike: number;
    marketMid: number;
    weight?: number;
    isCall?: boolean;
    vega?: number;
}
export interface FitOptions {
    minTick: number;
    minTVTicks: number;
    minTVFracOfCC: number;
    applyTickFloorWithinBand?: boolean;
    minTVAbsFloorTicks?: number;
    maxOutlierTrimBps?: number;
    robustLoss?: 'huber' | 'tukey';
    huberC?: number;
    tukeyC?: number;
    enforceCallConvexity?: boolean;
    convexityTol?: number;
    taperBand?: number;
    taperExp?: number;
}
export interface FitInput {
    legs: Leg[];
    forward: number;
    ccTV: number[];
    phi: number[];
    options: FitOptions;
}
export interface FitResult {
    theta: number;
    tvFitted: number[];
    w0: number[];
    wFinal: number[];
    usedMask: boolean[];
    usedCount: number;
    rmseBps: number;
    degenerate: boolean;
    metadata: {
        irlsIters: number;
        thetaShrinkCount: number;
        trimmedCount: number;
        minTVSlack: number;
    };
}
//# sourceMappingURL=types.d.ts.map