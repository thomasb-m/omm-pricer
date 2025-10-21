// src/utils/timeAndType.ts
export const isCallFrom = (opt: 'C' | 'P') => opt === 'C';

export const msToYears = (expiryMs: number, nowMs: number = Date.now()) =>
  Math.max((expiryMs - nowMs) / (365.0 * 24 * 3600 * 1000), 1e-9);
