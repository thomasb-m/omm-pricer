// Auto-generated wrapper around './targetCurvePricing_impl' to enforce final size clamps.
import * as __impl from './targetCurvePricing_impl';

function __enforceFinalSizeCaps__(quote: any){
  try {
    const d: any = quote?.diagnostics ?? {};
    const baseBid = Math.max(0, Number(quote?.bidSize ?? 0));
    const baseAsk = Math.max(0, Number(quote?.askSize ?? 0));
    const willingBidCap = Number.isFinite(d.willingnessBid) ? Math.floor(d.willingnessBid + 1) : Infinity;
    const willingAskCap = Number.isFinite(d.willingnessAsk) ? Math.floor(d.willingnessAsk + 1) : Infinity;
    const r = Math.max(1, Number(d.r ?? d.riskAversion ?? 1) || 1);
    const rBid = Math.max(1, Math.floor(baseBid / r));
    const rAsk = Math.max(1, Math.floor(baseAsk / r));
    const tick = Math.max(Number(d.tick ?? 0.05) || 0.05, 1e-12);
    const ccBidCap = (Number.isFinite(d.ccUpper) && Number.isFinite(d.ccMid)) ? Math.max(1, Math.floor((d.ccUpper - d.ccMid) / tick)) : Infinity;
    const ccAskCap = (Number.isFinite(d.ccMid) && Number.isFinite(d.ccLower)) ? Math.max(1, Math.floor((d.ccMid - d.ccLower) / tick)) : Infinity;
    quote.bidSize = Math.max(1, Math.min(baseBid, rBid, willingBidCap, ccBidCap));
    quote.askSize = Math.max(1, Math.min(baseAsk, rAsk, willingAskCap, ccAskCap));
  } catch {}
  return quote;
}

const __wrap = (fn: any) => (...args: any[]) => __enforceFinalSizeCaps__((fn as any)(...args));
const __pick = (k: string) => ((__impl as any)[k]);

export const computeTargetCurvePricing = __wrap(__pick('computeTargetCurvePricing'));

export type * from './targetCurvePricing_impl';
