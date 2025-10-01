import { PrismaClient } from "@prisma/client";

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

// ---- math helpers
function erf(x:number){
  const sign = x < 0 ? -1 : 1;
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const t = 1/(1+p*Math.abs(x));
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t*Math.exp(-x*x);
  return sign*y;
}
const N = (x:number)=>0.5*(1+erf(x/Math.SQRT2));
const n = (x:number)=>Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI);

// ---- Black-76 greeks (futures options)
export function black76Greeks(
  F: number,
  K: number,
  T: number,
  sigma: number,
  isCall: boolean,
  df = 1
) {
  const sT = Math.max(1e-12, sigma * Math.sqrt(Math.max(T, 1e-12)));
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / sT;
  const d2 = d1 - sT;
  const pdf = n(d1);

  // price (Black 76, discounted by df)
  const callPrice = df * (F * N(d1) - K * N(d2));
  const putPrice  = df * (K * N(-d2) - F * N(-d1));
  const price = isCall ? callPrice : putPrice;

  const delta = (isCall ? N(d1) : (N(d1) - 1)) * df;
  const gamma = (df * pdf) / (F * sT);
  const vega  = df * F * pdf * Math.sqrt(Math.max(T, 1e-12));
  const theta = -df * (F * pdf * sigma / (2 * Math.sqrt(T))); // minimal (no carry)

  return { price, delta, gamma, vega, theta, d1, d2 };
}


// ---- helpers to fetch most recent market marks
export async function getLatestIndex(prisma: PrismaClient, indexName="btc_usd"){
  const r = await prisma.tickIndex.findFirst({ where:{ indexName }, orderBy:{ tsMs:"desc" }});
  return r?.price ?? null;
}
export async function getLatestTickerIV(prisma: PrismaClient, name: string){
  const r = await prisma.ticker.findFirst({ where:{ instrument: name, markIv: { not: null } }, orderBy:{ tsMs:"desc" }});
  return (r?.markIv ?? null);
}
export async function getLatestTickerMid(prisma: PrismaClient, name: string){
  const r = await prisma.ticker.findFirst({ where:{ instrument: name }, orderBy:{ tsMs:"desc" }});
  if(!r) return null;
  const mid = (r.bestBid!=null && r.bestAsk!=null) ? (r.bestBid+r.bestAsk)/2 : (r.markPrice ?? null);
  return mid;
}

// ---- risk aggregation
export type LegRisk = {
  instrument: string;
  qty: number;
  F: number | null;
  iv: number | null;
  mid: number | null;
  T: number | null;
  greeks?: { delta:number; gamma:number; vega:number; theta:number };
  pv?: number | null;            // position PV using mid
  unrealized?: number | null;    // (mid - avg)*qty
};
export type PortfolioRisk = {
  legs: LegRisk[];
  totals: { delta:number; gamma:number; vega:number; theta:number; pv:number; unrealized:number };
};

export async function computePortfolioRisk(prisma: PrismaClient): Promise<PortfolioRisk> {
  const positions = await prisma.position.findMany();
  if (positions.length === 0) {
    return { legs: [], totals: { delta: 0, gamma: 0, vega: 0, theta: 0, pv: 0, unrealized: 0 } };
  }

  const denom = (process.env.PNL_DENOM || "BTC").toUpperCase() as "BTC" | "USD";
  const Findex = await getLatestIndex(prisma, "btc_usd"); // BTCUSD spot
  const usdMult = denom === "USD" ? (Findex ?? 0) : 1;    // multiply BTC amounts by spot to show USD

  const metaMap = new Map<string, any>();
  const getMeta = async (name: string): Promise<any> => {
    if (metaMap.has(name)) return metaMap.get(name)!;
    const m: any = await prisma.instrument.findUnique({ where: { id: name } });
    if (m) metaMap.set(name, m);
    return m!;
  };

  const legs: LegRisk[] = [];
  let td = 0, tg = 0, tv = 0, tt = 0, tpv = 0, tunr = 0;

  for (const p of positions) {
    const meta = await getMeta(p.instrument);
    if (!meta) continue;

    // Futures leg (no optionType)
    if (!meta.optionType) {
      const F = Findex;
      const mid = F;
      const pvBTC = (mid != null) ? (mid - p.avgPrice) * p.qty : null;
      const pv = pvBTC != null ? pvBTC * (denom === "USD" ? 1 : 1) : null; // for futures we already store USD-like price
      legs.push({
        instrument: p.instrument, qty: p.qty, F, iv: null, mid, T: null,
        greeks: { delta: p.qty, gamma: 0, vega: 0, theta: 0 },
        pv, unrealized: pv
      });
      td += p.qty; tpv += pv ?? 0; tunr += pv ?? 0;
      continue;
    }

    // Option leg (option prices are in BTC; convert if needed)
    const F = Findex;
    const iv = await getLatestTickerIV(prisma, p.instrument);
    const midBTC = await getLatestTickerMid(prisma, p.instrument); // BTC per option
    const now = Date.now();
    const T = (meta.expiryMs ? Number(meta.expiryMs) - now : 0) / YEAR_MS;
    const isCall = meta.optionType.toLowerCase().startsWith("c");

    let greeks, pv = null, unr = null;
    if (F != null && iv != null && T > 0) {
      greeks = black76Greeks(F, meta.strike ?? F, Math.max(T, 1e-6), Math.max(iv, 1e-4), isCall, 1.0);
      if (midBTC != null) {
        const pvBTC = (midBTC - p.avgPrice) * p.qty;  // PnL in BTC
        const pvConv = denom === "USD" ? pvBTC * (Findex ?? 0) : pvBTC;
        pv = pvConv; unr = pvConv;
      }
      td += greeks.delta * p.qty;
      tg += greeks.gamma * p.qty;
      tv += greeks.vega * p.qty;
      tt += greeks.theta * p.qty;
      tpv += pv ?? 0;
      tunr += unr ?? 0;
    }

    // present mid in selected denom too
    const mid = midBTC != null ? (denom === "USD" ? midBTC * usdMult : midBTC) : null;

    legs.push({ instrument: p.instrument, qty: p.qty, F, iv, mid, T, greeks, pv, unrealized: unr });
  }

  return { legs, totals: { delta: td, gamma: tg, vega: tv, theta: tt, pv: tpv, unrealized: tunr } };
}

// ---- realized PnL from fills
export async function computeRealizedPnL(prisma: PrismaClient){
  // super-simplified: sum(side) * price * qty with sign
  const fills = await prisma.fill.findMany();
  let realized = 0;
  for(const f of fills){
    const sgn = f.side === "sell" ? +1 : -1; // selling reduces long inventory -> realize gains
    realized += sgn * f.price * f.qty;
    if(f.fee) realized -= Math.abs(f.fee);
  }
  return realized;
}
