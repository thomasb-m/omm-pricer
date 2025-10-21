export function applyATMPin(
  k: number[], tv: number[], { pinStrength = 0.2 }: { pinStrength?: number } = {}
): number[] {
  const out = [...tv];
  const idx = k.map((v,i)=>[Math.abs(v),i]).sort((a,b)=>a[0]-b[0]).slice(0,3).map(x=>x[1]);
  const avg = idx.reduce((s,i)=>s+tv[i],0) / Math.max(1, idx.length);
  for (const i of idx) out[i] = (1 - pinStrength) * tv[i] + pinStrength * avg;
  return out;
}

export function applySoftFloors(
  tv: number[], { floor = 0 }: { floor?: number } = {}
): number[] {
  return tv.map(v => (v < floor ? 0.5 * (v + floor) : v));
}
