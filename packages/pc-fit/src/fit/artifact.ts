export type FitArtifact = {
  meta: { createdAt: string; method: string; notes?: string };
  grid: { k: number[]; tv: number[] };
  diagnostics?: Record<string, unknown>;
};

export function buildFitArtifact(
  k: number[],
  tv: number[],
  method = "irls+huber",
  diagnostics?: Record<string, unknown>
): FitArtifact {
  return {
    meta: { createdAt: new Date().toISOString(), method },
    grid: { k: [...k], tv: [...tv] },
    diagnostics
  };
}
