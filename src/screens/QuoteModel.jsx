import React, { useState, useMemo } from 'react';

// Math helpers
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const t = 1/(1+p*Math.abs(x));
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t*Math.exp(-x*x);
  return sign*y;
}
function N(x){ return 0.5 * (1 + erf(x/Math.SQRT2)); }
function n(x){ return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI); }

// Black-76 pricing
function black76Price(F, K, T, sigma, isCall = true) {
  const sT = Math.max(1e-12, sigma * Math.sqrt(Math.max(T, 1e-12)));
  const d1 = (Math.log(F/K) + 0.5*sigma*sigma*T)/sT;
  const d2 = d1 - sT;
  if(isCall){ return F * N(d1) - K * N(d2); }
  return K * N(-d2) - F * N(-d1);
}

function black76Greeks(F, K, T, sigma, isCall = true) {
  const sT = Math.max(1e-12, sigma * Math.sqrt(Math.max(T, 1e-12)));
  const d1 = (Math.log(F/K) + 0.5*sigma*sigma*T)/sT;
  const d2 = d1 - sT;
  const pdf = n(d1);
  const vega  = F * pdf * Math.sqrt(Math.max(T,1e-12));
  const gamma = pdf / (F * sT);
  const delta = (isCall ? 1 : -1) * N((isCall?1:-1)*d1);
  return { delta, gamma, vega };
}

// SVI total variance function (from Vol Model)
function sviTotalVar(k, params) {
  const { a, b, rho, m, s } = params;
  const x = k - m;
  return a + b * (rho * x + Math.sqrt(x*x + s*s));
}

function sviImpliedVol(k, T, params) {
  const w = sviTotalVar(k, params);
  return Math.sqrt(Math.max(1e-12, w / Math.max(T, 1e-12)));
}

export default function QuoteModel() {
  // Core inputs
  const [F, setF] = useState(111447.00); // BTC futures price
  const [K, setK] = useState(111000.00); // Strike
  const [T, setT] = useState(0.50); // years to expiry
  const [isCall, setIsCall] = useState(true);
  const [indexPrice, setIndexPrice] = useState(111447.00); // BTC index

  // Quote model parameters
  const [baseBps, setBaseBps] = useState(8); // Base spread in vol bps
  const [wDelta, setWDelta] = useState(0.02); // Risk weight for delta
  const [wGamma, setWGamma] = useState(1000); // Risk weight for gamma
  const [wVega, setWVega] = useState(0.05); // Risk weight for vega
  const [maxDSigmaBps, setMaxDSigmaBps] = useState(300); // Cap on vol add
  const [minWidthBtc, setMinWidthBtc] = useState(0.0001); // Min width in BTC
  const [maxWidthBtc, setMaxWidthBtc] = useState(0.01); // Max width in BTC
  const [qty, setQty] = useState(1); // Contracts

  // SVI parameters (from Vol Model - would be shared state in real app)
  const sviParams = {
    a: 0.08,
    b: 0.45,
    rho: -0.25,
    m: 0.00,
    s: 0.15
  };

  // Compute quote mechanics
  const quoteData = useMemo(() => {
    // 1. Model vol from SVI
    const k = Math.log(K / F);
    const modelVol = sviImpliedVol(k, T, sviParams);
    
    // 2. Mid price in BTC
    const midBtc = black76Price(F, K, T, modelVol, isCall);
    
    // 3. Greeks in BTC terms
    const greeks = black76Greeks(F, K, T, modelVol, isCall);
    
    // 4. Risk add (vol bps)
    const deltaRisk = wDelta * Math.pow(greeks.delta * qty, 2);
    const gammaRisk = wGamma * Math.pow(greeks.gamma * qty, 2);
    const vegaRisk = wVega * Math.pow(greeks.vega * qty, 2);
    const dSigmaRisk = Math.min(maxDSigmaBps / 10000, deltaRisk + gammaRisk + vegaRisk);
    
    // 5. Total vol add (bps)
    const dSigmaTot = (baseBps / 10000) + dSigmaRisk;
    
    // 6. Width in BTC
    const vegaEff = Math.max(1e-8, Math.abs(greeks.vega) * Math.max(1, Math.abs(qty)));
    const widthBtc = Math.max(minWidthBtc, Math.min(maxWidthBtc, vegaEff * dSigmaTot));
    
    // 7. Bid/Ask in BTC
    const bidBtc = midBtc - 0.5 * widthBtc;
    const askBtc = midBtc + 0.5 * widthBtc;
    
    // 8. USD mirrors
    const midUsd = midBtc * indexPrice;
    const bidUsd = bidBtc * indexPrice;
    const askUsd = askBtc * indexPrice;
    
    return {
      modelVol,
      midBtc,
      bidBtc,
      askBtc,
      midUsd,
      bidUsd,
      askUsd,
      greeks,
      dSigmaTot: dSigmaTot * 10000, // Convert back to bps
      widthBtc,
      appliedCaps: {
        dSigmaCapped: dSigmaRisk < (deltaRisk + gammaRisk + vegaRisk),
        widthCapped: widthBtc === maxWidthBtc
      }
    };
  }, [F, K, T, isCall, baseBps, wDelta, wGamma, wVega, maxDSigmaBps, minWidthBtc, maxWidthBtc, qty, indexPrice, sviParams]);

  const Field = ({ label, children, help }) => (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-gray-700">{label}</label>
      {children}
      {help && <div className="text-xs text-gray-500">{help}</div>}
    </div>
  );

  const NumberInput = ({ value, onChange, step = 0.01, min, max, precision = 4 }) => (
    <input
      type="number"
      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
      value={value}
      step={step}
      min={min}
      max={max}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
    />
  );

  const Stat = ({ label, value, unit = "", highlight = false }) => (
    <div className={`p-3 rounded-lg ${highlight ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-semibold ${highlight ? 'text-blue-700' : ''}`}>{value}{unit}</div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Inputs */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">Quote Model Inputs</h3>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Field label="Underlying F (USD)">
            <NumberInput value={F} onChange={setF} step={0.01} />
          </Field>
          <Field label="Strike K (USD)">
            <NumberInput value={K} onChange={setK} step={0.01} />
          </Field>
          <Field label="Expiry T (years)">
            <NumberInput value={T} onChange={setT} step={0.01} />
          </Field>
          <Field label="Type">
            <select 
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={isCall ? "Call" : "Put"}
              onChange={(e) => setIsCall(e.target.value === "Call")}
            >
              <option>Call</option>
              <option>Put</option>
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
          <Field label="Base Spread (vol bps)">
            <NumberInput value={baseBps} onChange={setBaseBps} step={0.5} min={0} max={100} />
          </Field>
          <Field label="Qty (contracts)">
            <NumberInput value={qty} onChange={setQty} step={1} min={1} />
          </Field>
          <Field label="BTC Index (USD)">
            <NumberInput value={indexPrice} onChange={setIndexPrice} step={0.01} />
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Risk Weights */}
        <div className="bg-white p-4 rounded-lg shadow border">
          <h3 className="text-lg font-semibold mb-4">Risk Weights</h3>
          
          <div className="space-y-4">
            <Field label="wΔ (Delta weight)" help="Quadratic penalty on delta">
              <NumberInput value={wDelta} onChange={setWDelta} step={0.005} min={0} />
            </Field>
            <Field label="wΓ (Gamma weight)" help="Quadratic penalty on gamma">
              <NumberInput value={wGamma} onChange={setWGamma} step={10} min={0} />
            </Field>
            <Field label="wVega (Vega weight)" help="Quadratic penalty on vega">
              <NumberInput value={wVega} onChange={setWVega} step={0.005} min={0} />
            </Field>
          </div>

          <div className="mt-6 space-y-4">
            <h4 className="font-medium">Quote Caps</h4>
            <Field label="Max dSigma (bps)" help="Cap on vol add">
              <NumberInput value={maxDSigmaBps} onChange={setMaxDSigmaBps} step={10} min={0} max={1000} />
            </Field>
            <Field label="Min Width (BTC)" help="Minimum quote width">
              <NumberInput value={minWidthBtc} onChange={setMinWidthBtc} step={0.0001} min={0} />
            </Field>
            <Field label="Max Width (BTC)" help="Maximum quote width">
              <NumberInput value={maxWidthBtc} onChange={setMaxWidthBtc} step={0.001} min={0} />
            </Field>
          </div>
        </div>

        {/* Quote Outputs */}
        <div className="bg-white p-4 rounded-lg shadow border">
          <h3 className="text-lg font-semibold mb-4">Quote Outputs</h3>
          
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Model Vol" value={quoteData.modelVol.toFixed(4)} unit="" />
              <Stat label="dSigma (bps)" value={quoteData.dSigmaTot.toFixed(1)} unit="" />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Mid (BTC)" value={quoteData.midBtc.toFixed(8)} unit="" highlight />
              <Stat label="Mid (USD)" value={`$${quoteData.midUsd.toFixed(2)}`} unit="" />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Bid (BTC)" value={quoteData.bidBtc.toFixed(8)} unit="" />
              <Stat label="Ask (BTC)" value={quoteData.askBtc.toFixed(8)} unit="" />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Bid (USD)" value={`$${quoteData.bidUsd.toFixed(2)}`} unit="" />
              <Stat label="Ask (USD)" value={`$${quoteData.askUsd.toFixed(2)}`} unit="" />
            </div>
            
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Δ (BTC/BTC)" value={quoteData.greeks.delta.toFixed(4)} unit="" />
              <Stat label="Γ (per $)" value={quoteData.greeks.gamma.toExponential(2)} unit="" />
              <Stat label="Vega (BTC/vol-pt)" value={quoteData.greeks.vega.toFixed(6)} unit="" />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Width (BTC)" value={quoteData.widthBtc.toFixed(8)} unit="" />
              <Stat label="Width (USD)" value={`$${(quoteData.widthBtc * indexPrice).toFixed(2)}`} unit="" />
            </div>
          </div>

          {/* Applied Caps */}
          <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
            <div className="text-sm font-medium text-yellow-800">Applied Caps:</div>
            <div className="text-xs text-yellow-700 mt-1">
              {quoteData.appliedCaps.dSigmaCapped && "• dSigma capped to max limit\n"}
              {quoteData.appliedCaps.widthCapped && "• Width capped to max limit\n"}
              {!quoteData.appliedCaps.dSigmaCapped && !quoteData.appliedCaps.widthCapped && "• No caps applied"}
            </div>
          </div>
        </div>
      </div>

      {/* Computation Steps */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">Computation Steps</h3>
        
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span>1. Model vol from SVI:</span>
            <span className="font-mono">{quoteData.modelVol.toFixed(4)}</span>
          </div>
          <div className="flex justify-between">
            <span>2. Mid (BTC):</span>
            <span className="font-mono">{quoteData.midBtc.toFixed(8)} BTC</span>
          </div>
          <div className="flex justify-between">
            <span>3. Greeks (Δ, Γ, Vega):</span>
            <span className="font-mono">
              {quoteData.greeks.delta.toFixed(4)}, {quoteData.greeks.gamma.toExponential(2)}, {quoteData.greeks.vega.toFixed(6)}
            </span>
          </div>
          <div className="flex justify-between">
            <span>4. Risk add (vol bps):</span>
            <span className="font-mono">{quoteData.dSigmaTot.toFixed(1)} bps</span>
          </div>
          <div className="flex justify-between">
            <span>5. Total vol add:</span>
            <span className="font-mono">{baseBps + quoteData.dSigmaTot.toFixed(1)} bps</span>
          </div>
          <div className="flex justify-between">
            <span>6. Width (BTC):</span>
            <span className="font-mono">{quoteData.widthBtc.toFixed(8)} BTC</span>
          </div>
          <div className="flex justify-between">
            <span>7. Bid/Ask (BTC):</span>
            <span className="font-mono">
              {quoteData.bidBtc.toFixed(8)} / {quoteData.askBtc.toFixed(8)}
            </span>
          </div>
          <div className="flex justify-between">
            <span>8. USD mirrors:</span>
            <span className="font-mono">
              ${quoteData.bidUsd.toFixed(2)} / ${quoteData.askUsd.toFixed(2)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
