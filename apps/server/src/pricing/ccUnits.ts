// apps/server/src/pricing/ccUnits.ts
import { black76Greeks } from "../risk";

/**
 * Return option price in BTC numeraire (Deribit-style), using Black-76.
 * - Input vol is sigma (not variance).
 * - Intrinsic floor enforced in BTC with a tiny slack.
 */
export function priceBTC_fromBlack76(
  F: number,
  K: number,
  T: number,
  sigma: number,
  isCall: boolean
) {
  const s = Math.max(sigma, 1e-6);
  const t = Math.max(T, 1e-9);

  // Use risk's unified greeks; .price is in USD numeraire
  // Many call-sites pass a notional of 1.0, so we keep that here for consistency.
  const g = black76Greeks(F, K, t, s, isCall, 1.0);
  const pUSD = g.price;

  // Deribit premiums are quoted in BTC → divide by F
  let pBTC = pUSD / Math.max(F, 1e-12);

  // Intrinsic floor in BTC (allow tiny slack)
  const intrinsicBTC = Math.max(0, (isCall ? F - K : K - F)) / Math.max(F, 1e-12);
  pBTC = Math.max(pBTC, intrinsicBTC - 2e-6);

  if (!Number.isFinite(pBTC)) {
    throw new Error(
      `priceBTC_fromBlack76 NaN: F=${F},K=${K},T=${T},σ=${sigma},isCall=${isCall}`
    );
  }
  return pBTC;
}

/**
 * Return greeks in BTC units (consistent with priceBTC_fromBlack76).
 * Notes:
 * - delta_btc is ∂(price_BTC)/∂F
 * - vega_btc  is ∂(price_BTC)/∂σ
 * - gamma_btc follows your existing scaling convention (matches prior code paths)
 */
export function greeksBTC_fromBlack76(
  F: number,
  K: number,
  T: number,
  sigma: number,
  isCall: boolean
) {
  const s = Math.max(sigma, 1e-6);
  const t = Math.max(T, 1e-9);

  const g = black76Greeks(F, K, t, s, isCall, 1.0);

  // Keep the same BTC-scaling conventions you've been using elsewhere.
  // (These match your prior implementation and downstream expectations.)
  const denom = Math.max(F, 1e-12);
  return {
    // price in BTC is available from priceBTC_fromBlack76; here we expose BTC-scaled greeks
    delta_btc: g.delta / denom, // ∂price_BTC/∂F
    vega_btc:  g.vega  / denom, // ∂price_BTC/∂σ
    gamma_btc: g.gamma * F,     // preserves your existing convention
    d1: g.d1,
    d2: g.d2,
  };
}
