import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, Scatter } from "recharts";

/**
 * Deribit BTC Options Pricer — Live Controller (Front-end)
 *
 * What changed per request:
 * - **Futures Price (F), Time-to-Expiry (T), and Risk-Free Rate (r) are NOT editable** on the UI.
 * - F should be fed live from your market feed. Pass it via the `F` prop to this component.
 * - T is computed **live** from a given `expiry` (UTC) prop (recomputed every second).
 * - r is an automated input — pass it via the `r` prop from your rate service; UI shows it read-only.
 *
 * Vol controls (editable): ATM Vol %, Skew %, Put Wing %, Call Wing %, Vol Path Rate.
 * Smile (demo): sigma(K) = atm + skew*ln(K/F) + (K<F?pWing : K>F?cWing : 0); then damp by volPathRate.
 * Pricing: Black-76 on futures with discount factor DF = exp(-r*T). Units: price in BTC (F and K are USD; this is model-only illustrative).
 */

// ---- Types (JSDoc) ----
/**
 * @typedef {Object} VolState
 * @property {number} atmVolPct - % e.g. 33.1
 * @property {number} skewPct - % per ln(K/F)
 * @property {number} pWingPct - % add for K<F
 * @property {number} cWingPct - % add for K>F
 * @property {number} volPathRatePct - % dampener (dimensionless scaling via %/100)
 */

/**
 * @typedef {Object} ParamConfig
 * @property {keyof VolState} key
 * @property {string} label
 * @property {number} step
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [decimals]
 * @property {string} [unit]
 */

const PARAMS = [
  { key: "atmVolPct", label: "ATM Vol", step: 0.1, min: 0, max: 500, decimals: 1, unit: "%" },
  { key: "skewPct", label: "Skew", step: 0.1, min: -200, max: 200, decimals: 1, unit: "%" },
  { key: "pWingPct", label: "Put Wing", step: 0.1, min: -200, max: 200, decimals: 1, unit: "%" },
  { key: "cWingPct", label: "Call Wing", step: 0.1, min: -200, max: 200, decimals: 1, unit: "%" },
  { key: "volPathRatePct", label: "Vol Path Rate", step: 0.1, min: 0, max: 200, decimals: 1, unit: "%" },
];

function clamp(n, min, max) {
  if (min != null && n < min) return min; if (max != null && n > max) return max; return n;
}

function effectiveStep(base, e) {
  let factor = 1; if (!e) return base;
  const anyE = e;
  if (anyE.shiftKey) factor *= 0.1; // fine
  if (anyE.altKey) factor *= 5;     // coarse
  if (anyE.ctrlKey || anyE.metaKey) factor *= 10; // big
  return base * factor;
}

// ---- Math (Black-76) ----
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

function cnd(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

function black76Call(F, K, T, sigma, r) {
  // DF = exp(-r T); F here is futures; price in futures numeraire then discount
  if (sigma <= 0 || T <= 0) return Math.max(F - K, 0) * Math.exp(-r * T);
  const vol = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K)) / vol + 0.5 * vol;
  const d2 = d1 - vol;
  const DF = Math.exp(-r * T);
  return DF * (F * cnd(d1) - K * cnd(d2));
}

function pctToVol(p) { return Math.max(0, p) / 100; }

// Smile function (demo)
function smileVolPct(K, F, s) {
  const m = Math.log(Math.max(1e-12, K / F));
  const wing = K < F ? s.pWingPct : (K > F ? s.cWingPct : 0);
  const raw = s.atmVolPct + s.skewPct * m + wing;
  const damp = 1.0 / (1.0 + pctToVol(s.volPathRatePct));
  return Math.max(0, raw * damp);
}

// ---- UI Tile ----
function ControlTile({ cfg, value, onChange }) {
  const repeatRef = useRef(null);
  const applyDelta = useCallback((delta, e) => {
    const step = effectiveStep(cfg.step, e);
    const next = Number((clamp(value + delta * step, cfg.min, cfg.max)).toFixed(cfg.decimals ?? 1));
    onChange(next);
  }, [cfg, value, onChange]);

  const startRepeat = useCallback((delta, e) => {
    applyDelta(delta, e);
    let delay = 300;
    const tick = () => { applyDelta(delta, e); delay = Math.max(40, delay * 0.86); repeatRef.current.timer = setTimeout(tick, delay); };
    repeatRef.current = { timer: setTimeout(tick, delay), delta, delay };
  }, [applyDelta]);

  const stopRepeat = useCallback(() => { if (repeatRef.current && repeatRef.current.timer) clearTimeout(repeatRef.current.timer); repeatRef.current = null; }, []);
  useEffect(() => { const up = () => stopRepeat(); window.addEventListener("mouseup", up); return () => window.removeEventListener("mouseup", up); }, [stopRepeat]);

  return (
    <div
      className="rounded-2xl border border-gray-200 p-4 bg-white hover:shadow-sm transition-shadow select-none"
      onMouseDown={(e) => { e.preventDefault(); if (e.button === 0) startRepeat(+1, e.nativeEvent); if (e.button === 2) startRepeat(-1, e.nativeEvent); }}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) => { e.preventDefault(); applyDelta(e.deltaY < 0 ? +1 : -1, e.nativeEvent); }}
      onKeyDown={(e) => { if (e.key === "ArrowUp") { e.preventDefault(); applyDelta(+1, e.nativeEvent); } if (e.key === "ArrowDown") { e.preventDefault(); applyDelta(-1, e.nativeEvent); } }}
      tabIndex={0}
    >
      <div className="text-sm text-gray-500 mb-2 flex items-center justify-between">
        <span>{cfg.label}</span>
        <span className="opacity-70">{cfg.unit}</span>
      </div>
      <div className="flex items-center gap-3">
        <button className="px-3 py-2 rounded-xl border" onClick={(e) => { e.preventDefault(); applyDelta(-1, e.nativeEvent); }}>–</button>
        <div className="flex-1 text-center text-2xl font-semibold tracking-tight tabular-nums">{value.toFixed(cfg.decimals ?? 1)}</div>
        <button className="px-3 py-2 rounded-xl border" onClick={(e) => { e.preventDefault(); applyDelta(+1, e.nativeEvent); }}>+</button>
      </div>
      <div className="mt-2 text-xs text-gray-500">Click & drag • Wheel • ↑/↓ (Shift ×0.1 • Alt ×5 • Ctrl/Cmd ×10)</div>
    </div>
  );
}

// ---- Chart ----
function ModelChart({ F, T, r, params, market }) {
  const data = useMemo(() => {
    const strikes = [];
    for (let k = 0.6 * F; k <= 1.8 * F; k += (1.8 * F - 0.6 * F) / 80) strikes.push(k);
    return strikes.map((K) => {
      const sigma = pctToVol(smileVolPct(K, F, params));
      const px = black76Call(F, K, T, sigma, r);
      return { K, model: px };
    });
  }, [F, T, r, params]);

  return (
    <div className="rounded-2xl border border-gray-200 p-4 bg-white">
      <h2 className="font-semibold mb-2">Live BTC Options — Model vs Deribit Market</h2>
      <div className="h-[360px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
            <XAxis dataKey="K" type="number" domain={[0.6 * F, 1.8 * F]} tickFormatter={(v) => v.toLocaleString()} label={{ value: "Strike (USD)", position: "insideBottom", offset: -5 }} />
            <YAxis dataKey="model" type="number" tickFormatter={(v) => v.toFixed(4)} label={{ value: "Option Price (BTC)", angle: -90, position: "insideLeft" }} />
            <Tooltip formatter={(v, n) => (n === "model" ? Number(v).toFixed(6) : v)} labelFormatter={(v) => `K=${Number(v).toLocaleString()}`} />
            <Legend />
            <Line name="Model (BTC)" type="monotone" dataKey="model" dot={false} />
            {market && market.length > 0 && (
              <Scatter name="Market (BTC)" data={market.map(m => ({ K: m.K, model: m.price }))} />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---- Main ----
export default function VolController({
  initial = { atmVolPct: 33.1, skewPct: 0.0, pWingPct: 0.0, cWingPct: 0.0, volPathRatePct: 0.0 },
  F = 111447,                   // live futures price (USD) from feed
  expiry,                       // UTC Date or ms — required for live TTX
  r = 0.00,                     // risk-free rate (annualized, decimal) — from rate service
  market = [],
  onChange,
  title = "Deribit BTC Vol — Live Controller",
  liveConnected = true,
}) {
  const [state, setState] = useState(initial);

  // Compute T from expiry continuously (years)
  const [T, setT] = useState(0);
  useEffect(() => {
    const getYears = () => {
      const now = Date.now();
      const e = typeof expiry === "number" ? expiry : expiry.getTime();
      return Math.max(0, (e - now) / (365.25 * 24 * 3600 * 1000));
    };
    setT(getYears());
    const id = setInterval(() => setT(getYears()), 1000);
    return () => clearInterval(id);
  }, [expiry]);

  useEffect(() => { onChange?.(state); }, [state, onChange]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Deribit BTC Options Pricer</h1>

      <div className="rounded-2xl border border-gray-200 bg-white">
        <div className="border-b px-4 py-3 font-semibold">{title}</div>

        {/* Volatility Model (editable) */}
        <div className="p-4">
          <h3 className="font-semibold mb-2">Volatility Model</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {PARAMS.map((cfg) => (
              <ControlTile key={cfg.key} cfg={cfg} value={state[cfg.key]} onChange={(v) => setState((prev) => ({ ...prev, [cfg.key]: v }))} />
            ))}
          </div>
        </div>

        {/* Market Parameters (read-only, live-fed) */}
        <div className="px-4 pb-4 text-sm text-gray-700 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <div className="font-semibold mb-1">Market Parameters</div>
            <div>Futures Price (USD): <span className="tabular-nums">{F.toLocaleString()}</span></div>
            <div>Time to Expiry (years): <span className="tabular-nums">{T.toFixed(6)}</span></div>
            <div>Risk-Free Rate (r): <span className="tabular-nums">{(r * 100).toFixed(3)}%</span></div>
            <div>Live Data: {liveConnected ? "✔ Connected" : "✖ Disconnected"}</div>
          </div>
          <div>
            <div className="font-semibold mb-1">Snapshot</div>
            <div>ATM IV (model): {(state.atmVolPct).toFixed(2)}%</div>
            <div>Skew: {(state.skewPct).toFixed(2)}%</div>
          </div>
        </div>
      </div>

      <ModelChart F={F} T={T} r={r} params={state} market={market} />
    </div>
  );
}
