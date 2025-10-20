import { Leg } from './types';

export interface SanitizedLegs {
  legs: Leg[];
  k: number[];
  indices: number[];
}

export function logMoneyness(strike: number, forward: number): number {
  return Math.log(strike / forward);
}

export function sanitizeLegs(legs: Leg[], forward: number): SanitizedLegs {
  const withK = legs
    .map((leg, idx) => ({ leg, idx }))
    .filter(({ leg }) =>
      Number.isFinite(leg.strike) &&
      Number.isFinite(leg.marketMid) &&
      leg.strike > 0 &&
      leg.marketMid >= 0
    )
    .map(({ leg, idx }) => ({
      leg,
      k: logMoneyness(leg.strike, forward),
      originalIdx: idx
    }));

  if (withK.length === 0) throw new Error('No valid legs after sanitization');

  withK.sort((a, b) => a.k - b.k);

  const dedup = new Map<number, typeof withK[0]>();
  for (const item of withK) {
    const ex = dedup.get(item.leg.strike);
    if (!ex || (item.leg.weight ?? 1) > (ex.leg.weight ?? 1)) {
      dedup.set(item.leg.strike, item);
    }
  }

  const sorted = Array.from(dedup.values()).sort((a, b) => a.k - b.k);

  return {
    legs: sorted.map(x => x.leg),
    k: sorted.map(x => x.k),
    indices: sorted.map(x => x.originalIdx)
  };
}
