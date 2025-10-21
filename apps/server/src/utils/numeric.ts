// apps/server/src/utils/numeric.ts
/**
 * Phase 1: Numeric safety guards and deterministic operations
 */

const WARNED_TAGS = new Set<string>();

/**
 * Guard against NaN/Infinity with once-per-tag warning
 * Returns 0 if invalid, otherwise returns x unchanged
 */
export function num(x: number, tag: string): number {
  if (Number.isFinite(x)) return x;
  
  if (!WARNED_TAGS.has(tag)) {
    console.warn(`[numeric] Non-finite value at "${tag}": ${x}`);
    WARNED_TAGS.add(tag);
  }
  
  return 0;
}

/**
 * Clamp value to [min, max]
 */
export function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num(x, 'clamp')));
}

/**
 * Deterministic sum over object values (sorted keys)
 */
export function deterministicSum(obj: Record<string, number>): number {
  const keys = Object.keys(obj).sort();
  let sum = 0;
  for (const k of keys) {
    sum += num(obj[k], `sum[${k}]`);
  }
  return sum;
}

/**
 * Deterministic sum over Map (sorted keys)
 */
export function deterministicMapSum(map: Map<string, number>): number {
  const keys = Array.from(map.keys()).sort();
  let sum = 0;
  for (const k of keys) {
    sum += num(map.get(k)!, `map[${k}]`);
  }
  return sum;
}

/**
 * Seeded PRNG (for deterministic fills in SimAdapter)
 * Simple LCG: x_n+1 = (a * x_n + c) mod m
 */
export class SeededRandom {
  private state: number;
  
  constructor(seed: number) {
    this.state = seed % 2147483647;
    if (this.state <= 0) this.state += 2147483646;
  }
  
  /**
   * Returns [0, 1)
   */
  next(): number {
    this.state = (this.state * 48271) % 2147483647;
    return (this.state - 1) / 2147483646;
  }
  
  /**
   * Returns normally distributed value (Box-Muller)
   */
  nextGaussian(): number {
    const u1 = this.next();
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

/**
 * Hash string to 32-bit integer (for seeding)
 */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Create deterministic RNG from timestamp + symbol
 */
export function createDeterministicRNG(ts: number, symbol: string): SeededRandom {
  const seed = ts ^ hashString(symbol);
  return new SeededRandom(seed);
}