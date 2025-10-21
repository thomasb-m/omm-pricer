import { describe, it, expect } from 'vitest';
import { toNorm, toUSD, safeMid } from '../../utils/units';
import { IntegratedSmileModel } from '../integratedSmileModel';

describe('unit conversions', () => {
  it('round-trips between USD and normalised prices within tolerance', () => {
    const forward = 112_750;
    const priceUSD = 4_250;

    const norm = toNorm(priceUSD, forward);
    const back = toUSD(norm, forward);

    expect(Math.abs(priceUSD - back)).toBeLessThan(1e-6 * forward);
  });

  it('safeMid prefers bid/ask and falls back to mark', () => {
    expect(safeMid(10, 14, 50)).toBeCloseTo(12);
    expect(safeMid(10, undefined, 50)).toBeCloseTo(10);
    expect(safeMid(undefined, 14, 50)).toBeCloseTo(14);
    expect(safeMid(undefined, undefined, 7.5)).toBeCloseTo(7.5);
    expect(safeMid(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe('updateMarketData', () => {
  it('stores normalised premiums when fed USD quotes', () => {
    const model = new IntegratedSmileModel('BTC');
    const forward = 113_000;
    const expiry = Date.now() + 7 * 24 * 3600 * 1000;
    const strike = 110_000;

    const midUSD = 5_000;
    const bidUSD = 4_800;
    const askUSD = 5_200;

    model.updateMarketData(
      expiry,
      strike,
      midUSD,
      forward,
      1,
      { denom: 'USD', midUSD, bidUSD, askUSD }
    );

    const cache = (model as any).marketDataCache.get(expiry) as Array<any>;
    expect(cache).toBeDefined();
    const entry = cache.find((row) => row.strike === strike);
    expect(entry).toBeDefined();

    const expectedNorm = midUSD / forward;
    expect(entry.midNorm).toBeCloseTo(expectedNorm, 12);
    expect(entry.midUSD).toBeCloseTo(midUSD, 8);
    expect(entry.bidUSD).toBeCloseTo(bidUSD, 8);
    expect(entry.askUSD).toBeCloseTo(askUSD, 8);
  });
});
