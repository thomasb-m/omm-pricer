import { black76Call } from "../../../../../packages/vol-core/src/black76";
import { sviIV } from "../../../../../packages/vol-core/src/smile";
import type { SVIParams, Quote } from "../../../../../packages/core-types/src/index";

export type PriceBreakdown = {
  intrinsic: number;
  tv: number;
  price: number;
};

export function priceCC(q: Quote, svi: SVIParams, T: number, df: number = 1.0): PriceBreakdown {
  // log-moneyness k = ln(K/F)
  const K = q.instrument.strike;
  const F = q.forward;
  const k = Math.log(K / F);

  const iv = sviIV(k, T, svi);
  const raw = black76Call(F, K, T, iv, df);
  const intrinsic = Math.max(F - K, 0) * df;
  return { intrinsic, tv: raw - intrinsic, price: raw };
}
