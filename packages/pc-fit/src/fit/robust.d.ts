export type RobustKind = "huber" | "tukey";
export interface IRLSOptions {
    kind?: RobustKind;
    c?: number;
    maxIter?: number;
    tol?: number;
}
export interface IRLSResult {
    beta0: number;
    beta1: number;
    weights: number[];
    residuals: number[];
    iters: number;
}
/** IRLS with Huber/Tukey weights */
export declare function irls(x: number[], y: number[], opts?: IRLSOptions): IRLSResult;
//# sourceMappingURL=robust.d.ts.map