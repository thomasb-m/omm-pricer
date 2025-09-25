import React, { useState, useMemo } from 'react';

// Mock data - in real app, this would come from trade DB
const mockPositions = [
  {
    instrument: "BTC-3OCT25-110000-C",
    side: "LONG",
    qty: 5,
    avg_price_btc: 0.0125,
    trade_ids: [1001, 1002, 1003]
  },
  {
    instrument: "BTC-3OCT25-112000-P",
    side: "SHORT",
    qty: 3,
    avg_price_btc: 0.0089,
    trade_ids: [1004, 1005]
  },
  {
    instrument: "BTC-3OCT25-111000-C",
    side: "LONG",
    qty: 2,
    avg_price_btc: 0.0156,
    trade_ids: [1006]
  }
];

const mockMarks = {
  "BTC-3OCT25-110000-C": { mark_iv: 0.3307, F: 111447, index_usd: 111447, T_years: 0.50 },
  "BTC-3OCT25-112000-P": { mark_iv: 0.3520, F: 111447, index_usd: 111447, T_years: 0.50 },
  "BTC-3OCT25-111000-C": { mark_iv: 0.3307, F: 111447, index_usd: 111447, T_years: 0.50 }
};

// Math helpers
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const t = 1/(1+p*Math.abs(x));
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t*Math.exp(-x*x);
  return sign*y;
}
function N(x){ return 0.5 * (1 + erf(x/Math.SQRT2)); }
function n(x){ return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI); }

// Black-76 pricing and greeks
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
  const theta = -F * pdf * sigma / (2 * Math.sqrt(T)) - (isCall ? 1 : -1) * F * N((isCall?1:-1)*d1) * 0.01; // Simplified theta
  return { delta, gamma, vega, theta };
}

export default function Risk() {
  // Filters
  const [selectedExpiry, setSelectedExpiry] = useState('3OCT25');
  const [selectedBucket, setSelectedBucket] = useState('all');
  const [selectedType, setSelectedType] = useState('all');
  const [selectedSide, setSelectedSide] = useState('all');

  // Current market data
  const [F, setF] = useState(111447.00);
  const [indexPrice, setIndexPrice] = useState(111447.00);

  // Filter positions
  const filteredPositions = useMemo(() => {
    return mockPositions.filter(pos => {
      const expiry = pos.instrument.split('-')[1];
      const isCall = pos.instrument.includes('-C');
      const side = pos.side;
      
      return (selectedExpiry === 'all' || expiry === selectedExpiry) &&
             (selectedType === 'all' || (selectedType === 'call' && isCall) || (selectedType === 'put' && !isCall)) &&
             (selectedSide === 'all' || side.toLowerCase() === selectedSide);
    });
  }, [selectedExpiry, selectedType, selectedSide]);

  // Calculate greeks for each position
  const positionData = useMemo(() => {
    return filteredPositions.map(pos => {
      const mark = mockMarks[pos.instrument];
      if (!mark) return null;

      const strike = parseFloat(pos.instrument.split('-')[2]);
      const isCall = pos.instrument.includes('-C');
      const signedQty = pos.side === 'LONG' ? pos.qty : -pos.qty;
      
      const greeks = black76Greeks(mark.F, strike, mark.T_years, mark.mark_iv, isCall);
      const price = black76Price(mark.F, strike, mark.T_years, mark.mark_iv, isCall);
      
      return {
        ...pos,
        strike,
        isCall,
        signedQty,
        greeks: {
          delta: greeks.delta * signedQty,
          gamma: greeks.gamma * signedQty,
          vega: greeks.vega * signedQty,
          theta: greeks.theta * signedQty
        },
        pv: price * signedQty,
        mark_iv: mark.mark_iv
      };
    }).filter(Boolean);
  }, [filteredPositions, F]);

  // Aggregate greeks by expiry
  const expiryTotals = useMemo(() => {
    const totals = {};
    positionData.forEach(pos => {
      const expiry = pos.instrument.split('-')[1];
      if (!totals[expiry]) {
        totals[expiry] = {
          qty: 0,
          delta: 0,
          gamma: 0,
          vega: 0,
          theta: 0,
          pv: 0
        };
      }
      totals[expiry].qty += pos.signedQty;
      totals[expiry].delta += pos.greeks.delta;
      totals[expiry].gamma += pos.greeks.gamma;
      totals[expiry].vega += pos.greeks.vega;
      totals[expiry].theta += pos.greeks.theta;
      totals[expiry].pv += pos.pv;
    });
    return totals;
  }, [positionData]);

  // Total portfolio greeks
  const portfolioTotals = useMemo(() => {
    return positionData.reduce((totals, pos) => ({
      qty: totals.qty + pos.signedQty,
      delta: totals.delta + pos.greeks.delta,
      gamma: totals.gamma + pos.greeks.gamma,
      vega: totals.vega + pos.greeks.vega,
      theta: totals.theta + pos.greeks.theta,
      pv: totals.pv + pos.pv
    }), { qty: 0, delta: 0, gamma: 0, vega: 0, theta: 0, pv: 0 });
  }, [positionData]);

  const Stat = ({ label, value, unit = "", highlight = false }) => (
    <div className={`p-3 rounded-lg ${highlight ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-semibold ${highlight ? 'text-blue-700' : ''}`}>{value}{unit}</div>
    </div>
  );

  const formatNumber = (num, decimals = 4) => {
    if (Math.abs(num) < 0.0001) return num.toExponential(2);
    return num.toFixed(decimals);
  };

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">Risk Filters</h3>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Expiry</label>
            <select 
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={selectedExpiry}
              onChange={(e) => setSelectedExpiry(e.target.value)}
            >
              <option value="all">All</option>
              <option value="3OCT25">3OCT25</option>
              <option value="31OCT25">31OCT25</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Bucket</label>
            <select 
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={selectedBucket}
              onChange={(e) => setSelectedBucket(e.target.value)}
            >
              <option value="all">All</option>
              <option value="0-7d">0-7d</option>
              <option value="7-30d">7-30d</option>
              <option value="30-90d">30-90d</option>
              <option value="90d+">90d+</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
            <select 
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
            >
              <option value="all">All</option>
              <option value="call">Call</option>
              <option value="put">Put</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Side</label>
            <select 
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={selectedSide}
              onChange={(e) => setSelectedSide(e.target.value)}
            >
              <option value="all">All</option>
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
          </div>
        </div>
      </div>

      {/* Portfolio Totals */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">Portfolio Totals</h3>
        
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <Stat label="Net Qty" value={portfolioTotals.qty} unit=" contracts" />
          <Stat label="Δ (BTC)" value={formatNumber(portfolioTotals.delta)} unit="" highlight />
          <Stat label="Γ (per $)" value={formatNumber(portfolioTotals.gamma)} unit="" />
          <Stat label="Vega (BTC/vol-pt)" value={formatNumber(portfolioTotals.vega)} unit="" />
          <Stat label="Θ (BTC/day)" value={formatNumber(portfolioTotals.theta)} unit="" />
          <Stat label="PV (BTC)" value={formatNumber(portfolioTotals.pv, 6)} unit="" />
        </div>
        
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Stat label="PV (USD)" value={`$${formatNumber(portfolioTotals.pv * indexPrice, 2)}`} unit="" />
          <Stat label="BTC Index" value={`$${indexPrice.toLocaleString()}`} unit="" />
        </div>
      </div>

      {/* By Expiry */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">By Expiry</h3>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Expiry</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Net Qty</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Δ (BTC)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Γ (per $)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Vega (BTC/vol-pt)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Θ (BTC/day)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">PV (BTC)</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {Object.entries(expiryTotals).map(([expiry, totals]) => (
                <tr key={expiry}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{expiry}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{totals.qty}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(totals.delta)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(totals.gamma)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(totals.vega)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(totals.theta)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(totals.pv, 6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* By Strike */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">By Strike (within expiry)</h3>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Instrument</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Side</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Qty</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Δ (BTC)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Γ (per $)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Vega (BTC/vol-pt)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Θ (BTC/day)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">PV (BTC)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Mark IV</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {positionData.map((pos, index) => (
                <tr key={index}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{pos.instrument}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{pos.side}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{pos.signedQty}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(pos.greeks.delta)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(pos.greeks.gamma)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(pos.greeks.vega)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(pos.greeks.theta)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(pos.pv, 6)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{(pos.mark_iv * 100).toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Hedge Panel */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">Hedge Suggestions</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-blue-50 p-4 rounded-lg">
            <h4 className="font-medium text-blue-900 mb-2">Futures Hedge</h4>
            <div className="text-sm text-blue-700">
              <div>Suggested futures position: <strong>{formatNumber(-portfolioTotals.delta)} contracts</strong></div>
              <div className="text-xs text-blue-600 mt-1">
                Hedge ratio = -Δ (futures per option)
              </div>
            </div>
          </div>
          
          <div className="bg-green-50 p-4 rounded-lg">
            <h4 className="font-medium text-green-900 mb-2">Vega Hedge</h4>
            <div className="text-sm text-green-700">
              <div>Vega exposure: <strong>{formatNumber(portfolioTotals.vega)} BTC/vol-pt</strong></div>
              <div className="text-xs text-green-600 mt-1">
                Consider nearby calendar spreads for vega hedging
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
