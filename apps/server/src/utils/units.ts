/**
 * Lightweight branded unit helpers to keep USD-vs-normalised pricing straight.
 * Normalised prices are denominated as a fraction of the forward (BTC fraction).
 */

export type USD = number & { __unit: 'usd' };
export type NORM = number & { __unit: 'norm' };

const EPS = 1e-12;

const assertFinite = (value: number, label: string): void => {
  if (!Number.isFinite(value)) {
    throw new Error(`Expected finite ${label}, received ${value}`);
  }
};

export const toNorm = (priceUSD: number, forwardUSD: number): NORM => {
  assertFinite(priceUSD, 'priceUSD');
  assertFinite(forwardUSD, 'forwardUSD');
  const denom = Math.max(Math.abs(forwardUSD), EPS);
  return (priceUSD / denom) as NORM;
};

export const toUSD = (priceNorm: number, forwardUSD: number): USD => {
  assertFinite(priceNorm, 'priceNorm');
  assertFinite(forwardUSD, 'forwardUSD');
  return (priceNorm * forwardUSD) as USD;
};

/**
 * Build a mid price without fabricating liquidity. Prefer real bid/ask,
 * fall back to mark, and otherwise return undefined to signal "skip".
 */
export function safeMid(
  bid?: number | null,
  ask?: number | null,
  mark?: number | null
): number | undefined {
  const validBid = Number.isFinite(bid) && Number(bid) > 0 ? Number(bid) : undefined;
  const validAsk = Number.isFinite(ask) && Number(ask) > 0 ? Number(ask) : undefined;
  const validMark = Number.isFinite(mark) && Number(mark) > 0 ? Number(mark) : undefined;

  if (validBid !== undefined && validAsk !== undefined && validAsk >= validBid) {
    return 0.5 * (validBid + validAsk);
  }

  if (validBid !== undefined) {
    return validBid;
  }

  if (validAsk !== undefined) {
    return validAsk;
  }

  if (validMark !== undefined) {
    return validMark;
  }

  return undefined;
}
