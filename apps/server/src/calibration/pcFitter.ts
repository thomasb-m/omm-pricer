import {
  fitConvexTV,
  sanitizeLegs,
  type FitOptions,
} from '@pc-fit/kit';

export type PCFitResult = {
  K: number[];
  tv: number[];
  theta: number;
  rmse: number;
};

/** Minimal adapter: robust WLS + convex repair, hardcoded defaults */
export function fitPCSmile(
  legs: Array<{ K: number; marketMid: number; weight?: number; vega?: number }>,
  ccTV: number[],
  phi: number[],
  forward: number,
  options: Pick<FitOptions, 'minTick' | 'minTVTicks' | 'minTVFracOfCC'> &
    Partial<Omit<FitOptions, 'minTick' | 'minTVTicks' | 'minTVFracOfCC'>>
): PCFitResult {
  if (legs.length !== ccTV.length || legs.length !== phi.length) {
    throw new Error('fitPCSmile: legs, ccTV, and phi arrays must have matching lengths');
  }

  const fitLegs = legs.map(leg => ({
    strike: leg.K,
    marketMid: Math.max(leg.marketMid, 0),
    weight: leg.weight,
    vega: leg.vega,
  }));

  const defaultedOptions: FitOptions = {
    minTick: options.minTick,
    minTVTicks: options.minTVTicks ?? 2,
    minTVFracOfCC: options.minTVFracOfCC ?? 0.5,
    applyTickFloorWithinBand: options.applyTickFloorWithinBand ?? true,
    minTVAbsFloorTicks: options.minTVAbsFloorTicks ?? 1,
    maxOutlierTrimBps: options.maxOutlierTrimBps ?? 150,
    robustLoss: options.robustLoss ?? 'huber',
    huberC: options.huberC ?? 1.5,
    tukeyC: options.tukeyC,
    enforceCallConvexity: options.enforceCallConvexity ?? true,
    convexityTol: options.convexityTol ?? 1e-6,
    taperBand: options.taperBand ?? 0.25,
    taperExp: options.taperExp ?? 1.0,
  };

  const phiVec = phi.map(p => (p > 0 ? p : 0));

  const sanitized = sanitizeLegs(fitLegs, forward);
  const result = fitConvexTV({
    legs: fitLegs,
    forward,
    ccTV,
    phi: phiVec,
    options: defaultedOptions,
  });

  const strikes = sanitized.legs.map(l => l.strike);
  const rmse = (result.rmseBps ?? 0) * 1e-4;

  return {
    K: strikes,
    tv: result.tvFitted,
    theta: result.theta,
    rmse,
  };
}
