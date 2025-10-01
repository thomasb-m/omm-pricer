export function timeToExpiryYears(expiryMs: number, now: number = Date.now()): number {
    const msInYear = 365 * 24 * 60 * 60 * 1000;
    return Math.max((expiryMs - now) / msInYear, 0);
  }

