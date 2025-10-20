import { describe, it, expect } from 'vitest';
import { taperAbsK } from '../src/interp';

describe('taperAbsK', () => {
  it('is 1 at ATM and decreases toward wings', () => {
    const k = [-0.3,-0.15,0,0.15,0.3];
    const phi = taperAbsK(k, 0.25, 1.0);
    expect(phi[2]).toBeGreaterThan(phi[1]);
    expect(phi[2]).toBeGreaterThan(phi[3]);
    expect(phi[0]).toBe(0);
    expect(phi[4]).toBe(0);
  });
});
