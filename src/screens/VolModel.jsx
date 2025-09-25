import React, { useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, Scatter, ScatterChart } from "recharts";

// -----------------------------
// JSDoc Types
// -----------------------------
/**
 * @typedef {Object} MarketPoint
 * @property {string} instrument - e.g., "BTC-3OCT25-112000-C"
 * @property {number} K - strike USD
 * @property {number} T - years to expiry
 * @property {"C"|"P"} type
 * @property {number} [price_btc] - market price in BTC (if available)
 * @property {number} [iv] - market IV as decimal (optional)
 */

// -----------------------------
// Math helpers: Black-76 & SVI (variance form)
// -----------------------------
function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x) {
  // Abramowitz & Stegun approximation
  const sign = Math.sign(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  return sign * y;
}

// Black-76 futures option (USD). DF≈1 assumed.
function black76PriceUSD(F, K, T, vol, type) {
  if (T <= 0 || vol <= 0) {
    const intrinsic = type === "C" ? Math.max(F - K, 0) : Math.max(K - F, 0);
    return intrinsic;
  }
  const sigmaSqrtT = vol * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * vol * vol * T) / sigmaSqrtT;
  const d2 = d1 - sigmaSqrtT;
  if (type === "C") return F * normCdf(d1) - K * normCdf(d2);
  return K * normCdf(-d2) - F * normCdf(-d1);
}

// SVI (total variance) w(k) = a + b{ rho(k-m) + sqrt((k-m)^2 + sigma^2) }
function sviTotalVariance(k, a, b, rho, m, sigma) {
  const x = k - m;
  return a + b * (rho * x + Math.sqrt(x * x + sigma * sigma));
}

// Map high-level UI nudges to an adjusted IV at k
function impliedVolFromSVIWithNudges(k, T, svi, nudges) {
  const { a, b, rho, m, sigma } = svi;
  const w = sviTotalVariance(k, a, b, rho, m, sigma);
  let iv = Math.sqrt(Math.max(w, 1e-12) / Math.max(T, 1e-9)); // base IV

  // Apply nudges in VOL bps (1 bp = 0.0001 in vol)
  const atmAdj = nudges.atm_bps * 1e-4; // parallel shift

  // Skew: add slope proportional to k
  const skewAdj = nudges.skew_bps_per_k * 1e-4 * k;

  // Wings: add piecewise adjustments by sign of k (OTM put = k<0, OTM call = k>0)
  const wingAdj = k < 0 ? nudges.put_wing_bps * 1e-4 : k > 0 ? nudges.call_wing_bps * 1e-4 : 0;

  iv = Math.max(1e-6, iv + atmAdj + skewAdj + wingAdj);
  return iv;
}

// -----------------------------
// UI Component
// -----------------------------
const Stepper = ({ label, description, value, step = 1, min = -999999, max = 999999, onChange, suffix }) => {
  const inc = () => onChange(Math.min(max, value + step));
  const dec = () => onChange(Math.max(min, value - step));
  return (
    <div className="flex flex-col gap-1 p-3 rounded-2xl border bg-white shadow-sm">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">{label}</label>
        {suffix ? <span className="text-xs text-gray-500">{suffix}</span> : null}
      </div>
      {description && <p className="text-xs text-gray-500">{description}</p>}
      <div className="flex items-center gap-2">
        <button 
          className="px-2 py-1 rounded-2xl border border-gray-300 hover:bg-gray-50 text-sm"
          onClick={dec}
        >–</button>
        <input
          value={value}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
          }}
          className="w-24 text-right px-2 py-1 border border-gray-300 rounded text-sm"
          type="number"
        />
        <button 
          className="px-2 py-1 rounded-2xl border border-gray-300 hover:bg-gray-50 text-sm"
          onClick={inc}
        >+</button>
      </div>
    </div>
  );
};

export default function VolModel() {
  // Core state
  const F_usd = 111447.00; // BTC futures price
  const index_usd = 111447.00; // BTC index
  const expiryUtc = "3OCT25 08:00"; // for display
  const atmStrike = 111000; // closest strike to F
  
  // Base SVI parameters
  const svi = { a: 0.08, b: 0.45, rho: -0.25, m: 0.00, sigma: 0.15 };
  
  // Mock market data
  const market = [
    { instrument: "BTC-3OCT25-110000-P", K: 110000, T: 0.50, type: "P", iv: 0.352 },
    { instrument: "BTC-3OCT25-111000-C", K: 111000, T: 0.50, type: "C", iv: 0.3307 },
    { instrument: "BTC-3OCT25-112000-C", K: 112000, T: 0.50, type: "C", iv: 0.318 },
    { instrument: "BTC-3OCT25-113000-C", K: 113000, T: 0.50, type: "C", iv: 0.294 },
  ];

  // High-level nudges (in vol bps)
  const [atmBps, setAtmBps] = useState(0); // ↑↓ Implied vol (parallel)
  const [skewBpsPerK, setSkewBpsPerK] = useState(0); // ↑↓ Skew (per unit k=ln(K/F))
  const [putWingBps, setPutWingBps] = useState(0); // ↑↓ OTM puts wing
  const [callWingBps, setCallWingBps] = useState(0); // ↑↓ OTM calls wing

  const data = useMemo(() => {
    // Build a strike grid around F for plotting
    const strikes = [];
    const n = 21; // odd count so K=F is centered
    const kMax = 0.5; // +-50% in log moneyness
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * 2 - 1; // -1..1
      const k = t * kMax;
      strikes.push(F_usd * Math.exp(k));
    }

    // Derive T per point: take from first market point or assume constant
    const T_default = market[0]?.T ?? 0.50; // ~6 months default

    const modelPoints = strikes.map((K) => {
      const k = Math.log(K / F_usd);
      const iv = impliedVolFromSVIWithNudges(k, T_default, svi, {
        atm_bps: atmBps,
        skew_bps_per_k: skewBpsPerK,
        put_wing_bps: putWingBps,
        call_wing_bps: callWingBps,
      });
      // Price calls for K>F and puts for K<F (OTM visualization)
      const type = K >= F_usd ? "C" : "P";
      const priceUSD = black76PriceUSD(F_usd, K, T_default, iv, type);
      const priceBTC = priceUSD / index_usd;
      return { K, k, iv, priceBTC, priceUSD, type };
    });

    // Prepare market series: if market price not provided, compute from IV
    const marketPoints = market.map((pt) => {
      const K = pt.K;
      const T = pt.T ?? T_default;
      const type = pt.type;
      let priceBTC = pt.price_btc;
      if (priceBTC == null && pt.iv != null) {
        const usd = black76PriceUSD(F_usd, K, T, pt.iv, type);
        priceBTC = usd / index_usd;
      }
      return { ...pt, price_btc: priceBTC };
    });

    return { modelPoints, marketPoints };
  }, [F_usd, index_usd, market, svi, atmBps, skewBpsPerK, putWingBps, callWingBps]);

  const atmIVModel = useMemo(() => {
    const T = market[0]?.T ?? 0.50;
    const iv = impliedVolFromSVIWithNudges(0, T, svi, {
      atm_bps: atmBps,
      skew_bps_per_k: skewBpsPerK,
      put_wing_bps: putWingBps,
      call_wing_bps: callWingBps,
    });
    return iv;
  }, [market, svi, atmBps, skewBpsPerK, putWingBps, callWingBps]);

  return (
    <div className="w-full grid grid-cols-1 xl:grid-cols-3 gap-4 p-4">
      <div className="xl:col-span-1 flex flex-col gap-4">
        <div className="rounded-2xl shadow border bg-white">
          <div className="p-6">
            <h3 className="text-lg font-semibold mb-4">Deribit BTC Vol — Controls</h3>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <Stepper
                  label="Implied Vol (ATM)"
                  description="Parallel shift (vol bps)"
                  value={atmBps}
                  step={5}
                  min={-1000}
                  max={1000}
                  onChange={setAtmBps}
                  suffix="bps"
                />
                <Stepper
                  label="Skew"
                  description="Slope per ln(K/F) (bps)"
                  value={skewBpsPerK}
                  step={5}
                  min={-2000}
                  max={2000}
                  onChange={setSkewBpsPerK}
                  suffix="bps/k"
                />
                <Stepper
                  label="Put Wing"
                  description="OTM puts adjustment (bps)"
                  value={putWingBps}
                  step={5}
                  min={-2000}
                  max={2000}
                  onChange={setPutWingBps}
                  suffix="bps"
                />
                <Stepper
                  label="Call Wing"
                  description="OTM calls adjustment (bps)"
                  value={callWingBps}
                  step={5}
                  min={-2000}
                  max={2000}
                  onChange={setCallWingBps}
                  suffix="bps"
                />
              </div>
              <div className="grid grid-cols-2 gap-3 mt-2 text-sm">
                <div className="p-3 rounded-2xl bg-gray-50">
                  <div className="text-gray-500">F (USD)</div>
                  <div className="font-mono">{F_usd.toLocaleString()}</div>
                </div>
                <div className="p-3 rounded-2xl bg-gray-50">
                  <div className="text-gray-500">Index (USD)</div>
                  <div className="font-mono">{index_usd.toLocaleString()}</div>
                </div>
                <div className="p-3 rounded-2xl bg-gray-50">
                  <div className="text-gray-500">Expiry (UTC)</div>
                  <div className="font-mono">{expiryUtc}</div>
                </div>
                <div className="p-3 rounded-2xl bg-gray-50">
                  <div className="text-gray-500">ATM Strike</div>
                  <div className="font-mono">{atmStrike.toLocaleString()}</div>
                </div>
                <div className="p-3 rounded-2xl bg-gray-50">
                  <div className="text-gray-500">ATM IV (model)</div>
                  <div className="font-mono">{(atmIVModel * 100).toFixed(2)}%</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="xl:col-span-2">
        <div className="rounded-2xl shadow h-full border bg-white">
          <div className="p-6">
            <h3 className="text-lg font-semibold mb-4">OTM Option Prices — Model vs Market</h3>
            <div className="h-[520px]">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 8, right: 16, bottom: 24, left: 0 }}>
                  <XAxis
                    type="number"
                    dataKey="K"
                    name="Strike"
                    tickFormatter={(v) => v.toLocaleString()}
                    domain={["auto", "auto"]}
                    label={{ value: "Strike (USD)", position: "bottom" }}
                  />
                  <YAxis
                    type="number"
                    dataKey="priceBTC"
                    name="Price (BTC)"
                    tickFormatter={(v) => v.toFixed(4)}
                    label={{ value: "Option Price (BTC)", angle: -90, position: "insideLeft" }}
                  />
                  <Tooltip
                    formatter={(value, name, props) => {
                      if (name === "Model (BTC)") return [(value).toFixed(6), name];
                      if (name === "Market (BTC)") return [(value).toFixed(6), name];
                      return [value, name];
                    }}
                    labelFormatter={(label) => `K: ${Number(label).toLocaleString()} USD`}
                  />
                  <Legend verticalAlign="top" height={36} />
                  {/* Model line (built from our grid) */}
                  <Line
                    type="monotone"
                    dataKey="priceBTC"
                    data={data.modelPoints}
                    name="Model (BTC)"
                    dot={false}
                    strokeWidth={2}
                    stroke="#3b82f6"
                  />
                  {/* Market dots */}
                  <Scatter 
                    data={data.marketPoints.map(mp => ({ K: mp.K, priceBTC: mp.price_btc }))} 
                    name="Market (BTC)" 
                    fill="#ef4444"
                  />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}