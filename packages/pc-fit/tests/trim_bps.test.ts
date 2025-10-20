import { describe, it, expect } from 'vitest';
import { trimByTVBps } from '../src/weights';

describe('trimByTVBps', () => {
  it('trims by bps of market TV', () => {
    const resid = [0, 0.001, 0.01];
    const mktTV = [0.01, 0.01, 0.01];
    const used = trimByTVBps(resid, mktTV, 1e-6, 50);
    expect(used[0]).toBe(true);
    expect(used[1]).toBe(false);
    expect(used[2]).toBe(false);
  });
});
