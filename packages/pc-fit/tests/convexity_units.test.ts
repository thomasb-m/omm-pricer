import { describe, it, expect } from 'vitest';
import { projectThetaByCallConvexity } from '../src/guards';

describe('projectThetaByCallConvexity units', () => {
  it('uses normalized intrinsic + TV', () => {
    const F = 100, strikes = [90,95,100,105,110];
    const cc = [0.04,0.038,0.037,0.038,0.04];
    const taper = [0.2,0.6,1,0.6,0.2];
    const { theta } = projectThetaByCallConvexity(0.01, strikes, F, cc, taper, 1e-6);
    expect(Number.isFinite(theta)).toBe(true);
  });
});
