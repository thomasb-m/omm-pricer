export function buildFitArtifact(k, tv, method = "irls+huber", diagnostics) {
    return {
        meta: { createdAt: new Date().toISOString(), method },
        grid: { k: [...k], tv: [...tv] },
        diagnostics
    };
}
//# sourceMappingURL=artifact.js.map