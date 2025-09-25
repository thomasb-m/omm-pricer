import React, { useMemo, useState, useEffect } from "react";

/* ===================== Math helpers ===================== */
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

/* ===================== Black-76 ===================== */
function black76Price(F, K, T, sigma, isCall=true, df=1.0){
  const sT = Math.max(1e-12, sigma * Math.sqrt(Math.max(T, 1e-12)));
  const d1 = (Math.log(F/K) + 0.5*sigma*sigma*T)/sT;
  const d2 = d1 - sT;
  if(isCall){ return df * (F * N(d1) - K * N(d2)); }
  return df * (K * N(-d2) - F * N(-d1));
}
function black76Greeks(F, K, T, sigma, isCall=true, df=1.0){
  const sT = Math.max(1e-12, sigma * Math.sqrt(Math.max(T, 1e-12)));
  const d1 = (Math.log(F/K) + 0.5*sigma*sigma*T)/sT;
  const d2 = d1 - sT;
  const pdf = n(d1);
  const vega  = df * F * pdf * Math.sqrt(Math.max(T,1e-12));
  const gamma = df * pdf / (F * sT);
  const delta = (isCall ? 1 : -1) * df * N((isCall?1:-1)*d1);
  const vomma = vega * d1 * d2 / Math.max(1e-12, sigma);
  const vanna = df * pdf * Math.sqrt(Math.max(T,1e-12)) * (1 - d1/sT);
  return { delta, gamma, vega, vomma, vanna, d1, d2 };
}

/* -------- Implied vol solver (Black-76) -------- */
function impliedVolFromPrice(target, F, K, T, isCall=true, df=1.0){
  // Newton with fallback bisection
  let sigma = 0.3; // start guess
  let lo = 1e-6, hi = 5.0;
  for (let i=0;i<20;i++){
    const price = black76Price(F, K, T, sigma, isCall, df);
    const diff = price - target;
    const vega = black76Greeks(F, K, T, sigma, isCall, df).vega;
    if (Math.abs(diff) < 1e-8) return Math.max(1e-6, sigma);
    if (vega > 1e-10) {
      const step = diff/vega;
      sigma = Math.max(1e-6, sigma - step);
    } else {
      break;
    }
    if (sigma < lo || sigma > hi) break;
  }
  // Bisection fallback
  let a=lo, b=hi;
  for (let i=0;i<60;i++){
    const mid = 0.5*(a+b);
    const pm = black76Price(F, K, T, mid, isCall, df) - target;
    const pa = black76Price(F, K, T, a, isCall, df) - target;
    if (pm === 0) return Math.max(1e-6, mid);
    if (pa*pm < 0) b = mid; else a = mid;
  }
  return Math.max(1e-6, 0.5*(a+b));
}

/* ===================== SVI smile (with knobs) ===================== */
function sviTotalVarRaw(k, params){
  const { a, b, rho, m, s } = params;
  const x = k - m;
  return a + b * (rho * x + Math.sqrt(x*x + s*s));
}
function sigmoid(x){ return 1/(1+Math.exp(-x)); }
function applySmileKnobs(F, K, T, baseParams, knobs){
  const k = Math.log(K/F);
  let a=baseParams.a, b=baseParams.b, rho=baseParams.rho, m=baseParams.m, s=baseParams.s;
  const { atmVolPct, skew, curv, wingL, wingR } = knobs;
  const targetAtmVol = Math.max(0.0005, atmVolPct/100);

  // Skew / curvature tweaks
  rho = clamp(rho + 0.25*skew, -0.999, 0.999);
  b   = Math.max(1e-6, b * (1 + 0.25*Math.abs(skew)));
  s   = Math.max(1e-6, s * (1 + 0.5*curv));
  b   = Math.max(1e-6, b * (1 + 0.1*curv));

  let w = sviTotalVarRaw(k, {a,b,rho,m,s});

  // Wing tilt
  const leftWeight = sigmoid(-3*k);
  const rightWeight = sigmoid(3*k);
  const wingMult = 1 + 0.2*wingL*leftWeight + 0.2*wingR*rightWeight;
  w *= Math.max(0.1, wingMult);

  // Renormalize ATM
  const wATMraw = sviTotalVarRaw(0, {a,b,rho,m,s});
  const atmVolRaw = Math.sqrt(Math.max(1e-12, wATMraw/Math.max(1e-12, T)));
  const scale = Math.pow(targetAtmVol / Math.max(1e-8, atmVolRaw), 2);
  w *= scale;

  const iv = Math.sqrt(Math.max(1e-12, w/Math.max(T,1e-12)));
  return { iv, w };
}

/* ===================== Risk charge ===================== */
function riskCharge(greeks, qty, weights){
  const d = greeks.delta * qty;
  const g = greeks.gamma * qty;
  const v = greeks.vega  * qty;
  const { delta:wD, gamma:wG, vega:wV } = weights;
  return 0.5*(wD*d*d + wG*g*g + wV*v*v);
}

/* ===================== Formatting helpers ===================== */
const fmt = (x, d=2) => Number(x).toLocaleString(undefined, { maximumFractionDigits: d });
const fmtPct = (x, d=2) => `${fmt(x*100, d)}%`;
const fmtExp = (x, d=2) => Number(x).toExponential(d);

/* ===================== Component ===================== */
export default function OMMInteractive(){
  // Core state - Deribit BTC-only
  const [product, setProduct] = useState("BTC");
  const [F, setF] = useState(111447.00); // BTC futures price in USD
  const [K, setK] = useState(111000.00); // Strike in USD
  const [T, setT] = useState(0.50);
  const [isCall, setIsCall] = useState(true);
  const [qty, setQty] = useState(1); // Number of BTC option contracts

  // Strike mode and moneyness
  const [strikeMode, setStrikeMode] = useState("ABS"); // "ABS" | "MNY"
  const [mnyPct, setMnyPct] = useState(100); // strike as % of F, used when strikeMode==="MNY"

  // Live data state
  const [wsStatus, setWsStatus] = useState("disconnected");
  const [optATM, setOptATM] = useState("");
  const [optWingC, setOptWingC] = useState("");
  const [optWingP, setOptWingP] = useState("");
  const [atmIvPct, setAtmIvPct] = useState(null);
  const [wingCIvPct, setWingCIvPct] = useState(null);
  const [wingPIvPct, setWingPIvPct] = useState(null);
  const [lastTickTs, setLastTickTs] = useState(null);

  // For IV inference fallback
  const [atmMeta, setAtmMeta] = useState(null);   // { K, expiryMs, isCall }

  // Smile knobs - Deribit BTC conventions
  const [atmVolPct, setAtmVolPct] = useState(33.07); // Typical BTC vol
  const [skew, setSkew] = useState(0);
  const [curv, setCurv] = useState(0);
  const [wingL, setWingL] = useState(0);
  const [wingR, setWingR] = useState(0);

  // Risk/liq weights - BTC-native
  const [baseSpreadBps, setBaseSpreadBps] = useState(8);
  const [wDelta, setWDelta] = useState(0.02);
  const [wGamma, setWGamma] = useState(1000);
  const [wVega, setWVega] = useState(0.05);

  // BTC index price for USD conversion
  const [btcIndexPrice, setBtcIndexPrice] = useState(111447.00);

  // Keep K in sync if using % moneyness
  useEffect(() => {
    if (strikeMode === "MNY") {
      setK(Math.max(1e-8, (mnyPct/100) * F));
    }
  }, [strikeMode, mnyPct, F]);

  const setATM = () => {
    if (strikeMode === "ABS") setK(F);
    else setMnyPct(100);
  };

  /* -------- LIVE DATA: auto-pick ATM, +wing call, -wing put (Backend API) -------- */
  useEffect(() => {
    setWsStatus("connecting");
    
    // Use backend API instead of direct Deribit connection
    const fetchData = async () => {
      try {
        // Get instruments from backend
        const instrumentsRes = await fetch('http://localhost:3001/instruments');
        const instruments = await instrumentsRes.json();
        
        // Get latest index price from backend
        const indexRes = await fetch('http://localhost:3001/index/btc_usd?limit=1');
        const indexData = await indexRes.json();
        const spot = indexData[0]?.price || 100000; // fallback price
        
        setF(spot);
        setLastTickTs(Date.now());
        
        // Choose three options (ATM, +wing call, -wing put)
        const { atm, wingC, wingP, expiryMs } = chooseThree(instruments, spot) || {};
        if (atm) {
          setOptATM(atm.name);
          setOptWingC(wingC.name);
          setOptWingP(wingP.name);
          setAtmMeta({ K: atm.strike, expiryMs, isCall: atm.optionType === "call" });
        }
        
        setWsStatus("connected");
      } catch (error) {
        console.error('Backend connection error:', error);
        setWsStatus("error");
      }
    };
    
    fetchData();
    
        // Poll for updates every 5 seconds
        const pollInterval = setInterval(async () => {
          try {
            // Get latest ticker data for our selected options
            if (optATM) {
              const tickerRes = await fetch(`http://localhost:3001/tickers/${optATM}?limit=1`);
              const tickerData = await tickerRes.json();
              if (tickerData[0]) {
                const t = tickerData[0];
                console.log(`[frontend] ATM update: IV=${t.markIv}, underlying=${t.underlying}`);
                if (typeof t.markIv === "number") {
                  setAtmIvPct(t.markIv);
                  setAtmVolPct(t.markIv);
                }
                if (typeof t.underlying === "number") {
                  setF(t.underlying);
                }
                setLastTickTs(Date.now());
              }
            }
            
            // Also poll wing options
            if (optWingC) {
              const wingCRes = await fetch(`http://localhost:3001/tickers/${optWingC}?limit=1`);
              const wingCData = await wingCRes.json();
              if (wingCData[0] && typeof wingCData[0].markIv === "number") {
                setWingCIvPct(wingCData[0].markIv);
                setWingCVolPct(wingCData[0].markIv);
              }
            }
            
            if (optWingP) {
              const wingPRes = await fetch(`http://localhost:3001/tickers/${optWingP}?limit=1`);
              const wingPData = await wingPRes.json();
              if (wingPData[0] && typeof wingPData[0].markIv === "number") {
                setWingPIvPct(wingPData[0].markIv);
                setWingPVolPct(wingPData[0].markIv);
              }
            }
      } catch (error) {
        console.error('Polling error:', error);
      }
    }, 5000);
    
    return () => {
      clearInterval(pollInterval);
    };
  }, [optATM, optWingC, optWingP]);

  // Helper function to choose three options (ATM, +wing call, -wing put)
  function chooseThree(list, spot) {
    // 1) expiry ~7d
    const now = Date.now();
    const targetDays = 7;
    let bestExpTs = null, bestExpDiff = Infinity;
    const byExp = new Map();
    for (const ins of list) {
      const ts = ins.expiryMs;
      if (!byExp.has(ts)) byExp.set(ts, []);
      byExp.get(ts).push(ins);
      const days = (ts - now) / (1000*60*60*24);
      const diff = Math.abs(days - targetDays);
      if (diff < bestExpDiff) { bestExpDiff = diff; bestExpTs = ts; }
    }
    if (!bestExpTs) return null;

    const bucket = byExp.get(bestExpTs);
    // ATM: nearest strike to spot
    let atm=null, atmDiff=Infinity;
    // +wing call: ~ +10%
    let wingC=null, wingCDiff=Infinity, targetC=spot*1.10;
    // -wing put: ~ -10%
    let wingP=null, wingPDiff=Infinity, targetP=spot*0.90;

    for (const ins of bucket) {
      const d = Math.abs(ins.strike - spot);
      if (d < atmDiff) { atm = ins; atmDiff = d; }
      if (ins.strike >= targetC) {
        const dc = Math.abs(ins.strike - targetC);
        if (dc < wingCDiff && (ins.optionType === "call" || wingC === null)) {
          wingC = ins; wingCDiff = dc;
        }
      }
      if (ins.strike <= targetP) {
        const dp = Math.abs(ins.strike - targetP);
        if (dp < wingPDiff && (ins.optionType === "put" || wingP === null)) {
          wingP = ins; wingPDiff = dp;
        }
      }
    }
    // Fallbacks
    if (!wingC) {
      let best=null, diff=Infinity;
      for (const ins of bucket) {
        if (ins.strike > spot) {
          const d2 = Math.abs(ins.strike - targetC);
          if (d2 < diff) { best = ins; diff = d2; }
        }
      }
      wingC = best || atm;
    }
    if (!wingP) {
      let best=null, diff=Infinity;
      for (const ins of bucket) {
        if (ins.strike < spot) {
          const d2 = Math.abs(ins.strike - targetP);
          if (d2 < diff) { best = ins; diff = d2; }
        }
      }
      wingP = best || atm;
    }
    return { atm, wingC, wingP, expiryMs: bestExpTs };
  }

  /* -------- Base SVI seeds for Deribit BTC -------- */
  const baseSVI = useMemo(()=>{
    // Deribit BTC options SVI parameters
    return { a:0.08, b:0.45, rho:-0.25, m:0.00, s:0.15 };
  }, [product]);

  /* -------- Pricing, Greeks, quoting -------- */
  const { iv } = useMemo(()=>applySmileKnobs(F, K, T, baseSVI, { atmVolPct, skew, curv, wingL, wingR }),
    [F,K,T, baseSVI, atmVolPct, skew, curv, wingL, wingR]);

  // Black-76 pricing in BTC units (Deribit convention)
  const midBTC = useMemo(()=>black76Price(F, K, T, iv, isCall, 1.0), [F,K,T,iv,isCall]);
  const greeks = useMemo(()=>black76Greeks(F, K, T, iv, isCall, 1.0), [F,K,T,iv,isCall]);

  // Convert to BTC units and add USD conversion
  const midUSD = midBTC * btcIndexPrice;
  
  // Risk charge in BTC terms
  const vegaEff = Math.max(1e-8, Math.abs(greeks.vega) * Math.max(1, Math.abs(qty)));
  const rc = riskCharge(greeks, qty, { delta:wDelta, gamma:wGamma, vega:wVega });
  const lc = (Math.abs(baseSpreadBps)/10000) * vegaEff; // vol bps → price via vega
  
  // Cap dSigma to prevent nonsensical quotes
  const dSigmaRaw = (rc + lc) / vegaEff;
  const dSigma = Math.min(Math.max(dSigmaRaw, -0.03), 0.03); // Cap at ±300 bps
  
  const bidBTC = black76Price(F, K, T, Math.max(1e-4, iv - dSigma), isCall, 1.0);
  const askBTC = black76Price(F, K, T, iv + dSigma, isCall, 1.0);
  const bidUSD = bidBTC * btcIndexPrice;
  const askUSD = askBTC * btcIndexPrice;

  /* -------- Fit-to-market (ATM + two wings) - Deribit BTC -------- */
  function fitSmileToTargets() {
    if (atmIvPct == null || wingCIvPct == null || wingPIvPct == null) {
      alert("Waiting for live Deribit ATM and wing IVs…");
      return;
    }
    const K_atm   = F;
    const K_call  = F * 1.10;
    const K_put   = F * 0.90;
    const targetATM  = atmIvPct / 100.0;
    const targetCall = wingCIvPct / 100.0;
    const targetPut  = wingPIvPct / 100.0;

    let best = { err: Infinity, skew, curv, wingL, wingR };
    const skewGrid = [-1, -0.5, 0, 0.5, 1];
    const curvGrid = [-1, 0, 1];
    const wingGrid = [-1, 0, 1];

    for (const sk of skewGrid) {
      for (const cu of curvGrid) {
        for (const wl of wingGrid) {
          for (const wr of wingGrid) {
            const knobs = { atmVolPct: atmIvPct, skew: sk, curv: cu, wingL: wl, wingR: wr };
            const ivATM  = applySmileKnobs(F, K_atm,  T, baseSVI, knobs).iv;
            const ivCall = applySmileKnobs(F, K_call, T, baseSVI, knobs).iv;
            const ivPut  = applySmileKnobs(F, K_put,  T, baseSVI, knobs).iv;
            const err = 0.25*Math.pow(ivATM - targetATM, 2)
                      + 0.5*Math.pow(ivCall - targetCall, 2)
                      + 0.5*Math.pow(ivPut  - targetPut,  2);
            if (err < best.err) best = { err, skew: sk, curv: cu, wingL: wl, wingR: wr };
          }
        }
      }
    }
    setAtmVolPct(atmIvPct);
    setSkew(best.skew);
    setCurv(best.curv);
    setWingL(best.wingL);
    setWingR(best.wingR);
  }

  /* -------- UI helpers -------- */
  const Field = ({label, children}) => (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-500">{label}</label>
      {children}
    </div>
  );
  const NumberInput = ({value, onChange, step=0.01, min, max}) => (
    <input type="number" className="w-full rounded-xl border p-2" value={value}
      step={step} min={min} max={max}
      onChange={(e)=>onChange(parseFloat(e.target.value))} />
  );
  const Slider = ({value, onChange, min, max, step}) => (
    <input type="range" className="w-full" value={value} min={min} max={max} step={step}
      onChange={(e)=>onChange(parseFloat(e.target.value))} />
  );
  const Stat = ({label, value}) => (
    <div className="p-3 rounded-xl bg-gray-50">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );

  const lastSeen = lastTickTs ? `${Math.round((Date.now()-lastTickTs)/1000)}s ago` : "—";

  // Check for strike mismatch
  const logMoneyness = Math.abs(Math.log(F / Math.max(1e-8, K)));
  const badStrike = logMoneyness > 0.5; // ~±65% away from ATM

  /* ===================== Render ===================== */
  return (
    <div className="p-6 max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <div className="p-4 rounded-2xl shadow border bg-white">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Single-Leg Pricer — **Deribit BTC Options** (Black-76 on futures, SVI smile)</h2>
            <div className="text-sm text-gray-600">BTC Options Only</div>
          </div>

          <p className="text-xs text-gray-500 mb-3">
            Deribit Live Data: {wsStatus}
            {optATM && <> • ATM: <strong>{optATM}</strong></>}
            {optWingC && <> • +wing: <strong>{optWingC}</strong></>}
            {optWingP && <> • –wing: <strong>{optWingP}</strong></>}
            {' '}• last tick: {lastSeen}
            {atmIvPct!=null && <> • atm_iv: {atmIvPct.toFixed(2)}%</>}
            {wingCIvPct!=null && <> • +wing_iv: {wingCIvPct.toFixed(2)}%</>}
            {wingPIvPct!=null && <> • –wing_iv: {wingPIvPct.toFixed(2)}%</>}
            <br />
            <span className="text-blue-600">BTC Options: All prices in BTC, USD shown for convenience</span>
          </p>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Field label="Underlying F (USD)">
              <NumberInput value={F} onChange={setF} step={0.01} />
              <div className="text-xs text-gray-500">Deribit BTC futures price</div>
            </Field>

            {strikeMode === "ABS" ? (
              <Field label="Strike K (USD)">
                <NumberInput value={K} onChange={setK} step={0.01} />
                <div className="text-xs text-gray-500">Exact Deribit strike</div>
              </Field>
            ) : (
              <Field label="Strike (% of F)">
                <NumberInput value={mnyPct} onChange={setMnyPct} step={0.1} />
              </Field>
            )}

            <Field label="Expiry T (years)">
              <NumberInput value={T} onChange={setT} step={0.01} />
              <div className="text-xs text-gray-500">Years to Deribit expiry</div>
            </Field>

            <Field label="Type">
              <select className="border rounded-xl p-2" value={isCall ? "Call" : "Put"}
                onChange={e=>setIsCall(e.target.value==="Call")}>
                <option>Call</option><option>Put</option>
              </select>
            </Field>

            <Field label="Qty (contracts)">
              <NumberInput value={qty} onChange={setQty} step={1} />
              <div className="text-xs text-gray-500">1 BTC per contract</div>
            </Field>

            <Field label="BTC Index Price (USD)">
              <NumberInput value={btcIndexPrice} onChange={setBtcIndexPrice} step={0.01} />
              <div className="text-xs text-gray-500">For USD conversion</div>
            </Field>
          </div>

          <div className="col-span-2 flex gap-2 items-end mt-4">
            <button className="px-3 py-2 rounded-xl border" onClick={setATM}>Set ATM</button>
            <select className="border rounded-xl p-2" value={strikeMode} onChange={e=>setStrikeMode(e.target.value)}>
              <option value="ABS">Strike in price</option>
              <option value="MNY">Strike as % of F</option>
            </select>
            <div className="text-xs text-gray-500 ml-2">K={fmt(K,2)} ({fmt((K/F-1)*100,2)}% moneyness)</div>
          </div>

          {badStrike && (
            <div className="mt-2 p-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs">
              Heads up: K is far from F (|ln(F/K)|≳0.5). You'll get Δ≈1, Γ≈0, IV inflated. Click <em>Set ATM</em>, or try strike as <em>% of F</em>.
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-3 rounded-xl bg-gray-50">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">ATM Vol (%)</span>
                <span className="text-sm tabular-nums">{atmVolPct.toFixed(2)}</span>
              </div>
              <Slider value={atmVolPct} onChange={setAtmVolPct} min={1} max={200} step={0.05} />
              <div className="mt-3 flex items-center justify-between">
                <span className="text-sm font-medium">Skew</span>
                <span className="text-sm tabular-nums">{skew.toFixed(2)}</span>
              </div>
              <Slider value={skew} onChange={setSkew} min={-2} max={2} step={0.01} />
              <div className="mt-3 flex items-center justify-between">
                <span className="text-sm font-medium">Curvature</span>
                <span className="text-sm tabular-nums">{curv.toFixed(2)}</span>
              </div>
              <Slider value={curv} onChange={setCurv} min={-2} max={2} step={0.01} />
              <div className="mt-3 flex items-center justify-between">
                <span className="text-sm font-medium">Left Wing</span>
                <span className="text-sm tabular-nums">{wingL.toFixed(2)}</span>
              </div>
              <Slider value={wingL} onChange={setWingL} min={-2} max={2} step={0.01} />
              <div className="mt-3 flex items-center justify-between">
                <span className="text-sm font-medium">Right Wing</span>
                <span className="text-sm tabular-nums">{wingR.toFixed(2)}</span>
              </div>
              <Slider value={wingR} onChange={setWingR} min={-2} max={2} step={0.01} />

              <button
                className="mt-4 px-3 py-2 rounded-xl bg-black text-white text-sm disabled:opacity-40"
                onClick={fitSmileToTargets}
                disabled={atmIvPct==null || wingCIvPct==null || wingPIvPct==null}
              >
                Fit SVI to Deribit market (ATM & wings)
              </button>
            </div>

            <div className="p-3 rounded-xl bg-gray-50">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Base Spread (vol bps)</span>
                <span className="text-sm tabular-nums">{baseSpreadBps.toFixed(1)}</span>
              </div>
              <Slider value={baseSpreadBps} onChange={setBaseSpreadBps} min={0} max={50} step={0.5} />

              <div className="grid grid-cols-3 gap-3 mt-3">
                <Field label="wΔ">
                  <NumberInput value={wDelta} onChange={setWDelta} step={0.005} />
                </Field>
                <Field label="wΓ">
                  <NumberInput value={wGamma} onChange={setWGamma} step={10} />
                </Field>
                <Field label="wVega">
                  <NumberInput value={wVega} onChange={setWVega} step={0.005} />
                </Field>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Risk weights set the quadratic penalty on inventory for Δ/Γ/vega in BTC terms.
                Spreads widen if the trade increases risk; tighten if it reduces it.
                All risk calculations are in BTC (Deribit's settlement currency).
              </p>
            </div>
          </div>
        </div>

        <div className="p-4 rounded-2xl shadow border bg-white">
          <h3 className="text-base font-semibold mb-3">Outputs (Deribit BTC Options)</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="Implied Vol" value={fmtPct(iv,2)} />
            <Stat label="Mid Price (BTC)" value={fmt(midBTC,8)} />
            <Stat label="Mid Price (USD)" value={`$${fmt(midUSD,2)}`} />
            <Stat label="BTC Index" value={`$${fmt(btcIndexPrice,2)}`} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
            <Stat label="Bid (BTC)" value={fmt(bidBTC,8)} />
            <Stat label="Ask (BTC)" value={fmt(askBTC,8)} />
            <Stat label="Bid (USD)" value={`$${fmt(bidUSD,2)}`} />
            <Stat label="Ask (USD)" value={`$${fmt(askUSD,2)}`} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-4">
            <Stat label="Delta (BTC/BTC)" value={fmt(greeks.delta,4)} />
            <Stat label="Gamma (per $1)" value={fmtExp(greeks.gamma,2)} />
            <Stat label="Vega (BTC/vol-pt)" value={fmt(greeks.vega,6)} />
            <Stat label="dSigma (vol)" value={`${fmt(dSigma*10000,1)} bps`} />
            <Stat label="Risk Charge (BTC)" value={fmt(rc,8)} />
          </div>

          <p className="text-xs text-gray-500 mt-3">
            All option prices are in BTC (Deribit settlement currency). USD prices shown for convenience.
            Greeks computed with respect to futures price F. DF≈1 for futures options.
          </p>
        </div>

        {/* Risk & P&L Panel - BTC Native */}
        <div className="p-4 rounded-2xl shadow border bg-white">
          <h3 className="text-base font-semibold mb-3">Risk & P&L (BTC Inventory)</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="Current Δ (BTC)" value={fmt(greeks.delta * qty, 6)} />
            <Stat label="Current Γ (BTC)" value={fmtExp(greeks.gamma * qty, 2)} />
            <Stat label="Current Vega (BTC)" value={fmt(greeks.vega * qty, 6)} />
            <Stat label="Hedge Ratio" value={`${fmt(greeks.delta, 4)} futures/option`} />
          </div>
          
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
            <Stat label="Position Value (BTC)" value={fmt(midBTC * qty, 8)} />
            <Stat label="Position Value (USD)" value={`$${fmt(midUSD * qty, 2)}`} />
            <Stat label="Risk Charge (BTC)" value={fmt(rc, 8)} />
          </div>

          <p className="text-xs text-gray-500 mt-3">
            All risk calculations in BTC (Deribit settlement currency). 
            Hedge ratio shows futures contracts needed per option contract.
          </p>
        </div>
      </div>
    </div>
  );
}
