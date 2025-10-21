import {
  baseWeights,
  wlsFitConvexTV,
  applyTrimBps,
  huberWeights,
  convexRepair,
} from 'pc-fit';

export type PCFitResult = {
  K: number[];
  tv: number[];
  theta: number;
  rmse: number;
};

/** Minimal adapter: robust WLS + convex repair, hardcoded defaults */
export function fitPCSmile(
  legs: Array<{ K: number; marketMid: number; vega?: number; phi?: number }>,
  F: number,
  T: number
): PCFitResult {
  const K    = legs.map(l => l.K);
  const mid  = legs.map(l => Math.max(l.marketMid, 0));
  const vega = legs.map(l => Math.max(l.vega ?? 1, 1));
  const phi  = legs.map(l => l.phi ?? 0);

  const prelim = applyTrimBps(mid, 25);
  const w0 = baseWeights(vega);
  const floorVec = K.map(() => 0);
  const loss = (r: number[]) => huberWeights(r, 1.5);

  const { tv, theta, rmse } = wlsFitConvexTV({
    K, mid, F, T, w0, floorVec, phi,
    lossWeights: loss,
    convexityPenalty: 1e-3,
    maxIter: 6,
    prelim,
  });

  const tvConvex = convexRepair(K, tv, floorVec);
  return { K, tv: tvConvex, theta, rmse };
}
