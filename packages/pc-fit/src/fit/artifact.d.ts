export type FitArtifact = {
    meta: {
        createdAt: string;
        method: string;
        notes?: string;
    };
    grid: {
        k: number[];
        tv: number[];
    };
    diagnostics?: Record<string, unknown>;
};
export declare function buildFitArtifact(k: number[], tv: number[], method?: string, diagnostics?: Record<string, unknown>): FitArtifact;
//# sourceMappingURL=artifact.d.ts.map