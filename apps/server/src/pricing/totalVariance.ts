import { tauIntegral, overnightMasses } from "./seasonality";
import { eventMasses } from "./eventTable";

export function totalVariance(params: {
  symbol: string;
  baseSigma: number;
  startMs: number;
  endMs: number;
}): number {
  const { symbol, baseSigma, startMs, endMs } = params;

  if (!Number.isFinite(baseSigma) || baseSigma < 0) return 0;
  if (endMs <= startMs) return 0;

  const tau = tauIntegral(startMs, endMs);
  const wDiff = baseSigma * baseSigma * tau;
  const wON = overnightMasses(startMs, endMs);
  const wEvt = eventMasses(symbol, startMs, endMs);
  
  const total = Math.max(0, wDiff + wON + wEvt);
  
  // Debug: log breakdown (comment out in prod)
  if (Math.random() < 0.01) { // 1% sample rate
    console.log(`[totalVariance] ${symbol}: τ=${tau.toFixed(6)}, wDiff=${wDiff.toFixed(6)}, wON=${wON.toFixed(6)}, wEvt=${wEvt.toFixed(6)}, total=${total.toFixed(6)}`);
  }

  return total;
}
