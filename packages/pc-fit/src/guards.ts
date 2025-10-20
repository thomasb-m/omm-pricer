type Block = { start: number; end: number; sum: number; width: number };

export function convexRepair(strikes: number[], tv: number[], lower: number[]): number[] {
  const n = tv.length;
  const x = tv.map((v, i) => Math.max(v, lower[i]));
  
  const widths = Array.from({ length: n - 1 }, (_, i) => 
    Math.max(1e-12, strikes[i + 1] - strikes[i])
  );
  
  const slopes = widths.map((h, i) => (x[i + 1] - x[i]) / h);

  const blocks: Block[] = [];
  for (let i = 0; i < slopes.length; i++) {
    blocks.push({ 
      start: i, 
      end: i + 1, 
      sum: slopes[i] * widths[i], 
      width: widths[i] 
    });
    
    while (blocks.length >= 2) {
      const a = blocks[blocks.length - 2];
      const b = blocks[blocks.length - 1];
      if (a.sum / a.width <= b.sum / b.width) break;
      
      blocks.splice(blocks.length - 2, 2, {
        start: a.start,
        end: b.end,
        sum: a.sum + b.sum,
        width: a.width + b.width
      });
    }
  }

  const sMon = new Array(slopes.length);
  for (const bl of blocks) {
    const avg = bl.sum / bl.width;
    for (let i = bl.start; i < bl.end; i++) {
      sMon[i] = avg;
    }
  }

  const out = new Array(n);
  out[0] = x[0];
  for (let i = 0; i < sMon.length; i++) {
    out[i + 1] = out[i] + sMon[i] * widths[i];
  }

  for (let i = 0; i < n; i++) {
    out[i] = Math.max(out[i], lower[i]);
  }

  return out;
}

export function projectThetaByCallConvexity(
  theta: number,
  strikes: number[],
  forward: number,
  ccTV: number[],
  taper: number[],
  tol: number = 1e-6
): { theta: number; shrinkCount: number } {
  let shrinkCount = 0;
  let th = theta;

  for (let iter = 0; iter < 10; iter++) {
    const tv = ccTV.map((cc, i) => cc + th * taper[i]);
    const callMid = tv.map((t, i) => {
      const intrinsic = Math.max(0, 1 - strikes[i] / Math.max(forward, 1e-12));
      return intrinsic + t;
    });

    let maxViol = 0;
    for (let i = 1; i < strikes.length - 1; i++) {
      const K0 = strikes[i - 1], K1 = strikes[i], K2 = strikes[i + 1];
      const C0 = callMid[i - 1], C1 = callMid[i], C2 = callMid[i + 1];
      const dK1 = K1 - K0, dK2 = K2 - K1;
      const dC1 = (C1 - C0) / dK1, dC2 = (C2 - C1) / dK2;
      const d2C = (dC2 - dC1) / ((dK1 + dK2) / 2);
      maxViol = Math.max(maxViol, -d2C);
    }

    if (maxViol <= tol) break;
    th *= 0.8;
    shrinkCount++;
  }

  return { theta: th, shrinkCount };
}
