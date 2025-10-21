export function assertFinite(x: number, tag: string): void {
  if (!Number.isFinite(x)) {
    throw new Error(`Non-finite value at ${tag}: ${x}`);
  }
}

export function assertPositive(x: number, tag: string): void {
  assertFinite(x, tag);
  if (x <= 0) {
    throw new Error(`Non-positive value at ${tag}: ${x}`);
  }
}
