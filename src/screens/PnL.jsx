import React, { useState, useMemo } from 'react';

// Mock data - in real app, this would come from trade DB
const mockTrades = [
  {
    trade_id: 1001,
    ts: "2024-01-15T10:30:00Z",
    instrument: "BTC-3OCT25-110000-C",
    side: "BUY",
    qty: 3,
    price_btc: 0.0125,
    fee_btc: 0.0001
  },
  {
    trade_id: 1002,
    ts: "2024-01-15T11:15:00Z",
    instrument: "BTC-3OCT25-110000-C",
    side: "BUY",
    qty: 2,
    price_btc: 0.0128,
    fee_btc: 0.0001
  },
  {
    trade_id: 1003,
    ts: "2024-01-16T09:45:00Z",
    instrument: "BTC-3OCT25-110000-C",
    side: "SELL",
    qty: 1,
    price_btc: 0.0135,
    fee_btc: 0.0001
  },
  {
    trade_id: 1004,
    ts: "2024-01-16T14:20:00Z",
    instrument: "BTC-3OCT25-112000-P",
    side: "SELL",
    qty: 3,
    price_btc: 0.0089,
    fee_btc: 0.0001
  }
];

const mockPnLParams = {
  mark_source: "MODEL",
  index_usd: 111447,
  F: 111447
};

// Mock current marks for unrealized P&L
const mockCurrentMarks = {
  "BTC-3OCT25-110000-C": 0.0156, // BTC per contract
  "BTC-3OCT25-112000-P": 0.0092  // BTC per contract
};

export default function PnL() {
  const [selectedPeriod, setSelectedPeriod] = useState('today');
  const [markSource, setMarkSource] = useState('MODEL');

  // Calculate realized P&L from trades
  const realizedPnL = useMemo(() => {
    const instrumentTrades = {};
    
    // Group trades by instrument
    mockTrades.forEach(trade => {
      if (!instrumentTrades[trade.instrument]) {
        instrumentTrades[trade.instrument] = [];
      }
      instrumentTrades[trade.instrument].push(trade);
    });

    let totalRealizedBtc = 0;
    let totalFeesBtc = 0;
    const byInstrument = {};

    Object.entries(instrumentTrades).forEach(([instrument, trades]) => {
      // Sort by timestamp
      trades.sort((a, b) => new Date(a.ts) - new Date(b.ts));
      
      let position = 0;
      let avgCost = 0;
      let realizedBtc = 0;
      let feesBtc = 0;

      trades.forEach(trade => {
        const signedQty = trade.side === 'BUY' ? trade.qty : -trade.qty;
        const newPosition = position + signedQty;
        
        if (position > 0 && signedQty < 0) {
          // Closing long position
          const closeQty = Math.min(position, Math.abs(signedQty));
          const realized = closeQty * (trade.price_btc - avgCost);
          realizedBtc += realized;
        } else if (position < 0 && signedQty > 0) {
          // Closing short position
          const closeQty = Math.min(Math.abs(position), signedQty);
          const realized = closeQty * (avgCost - trade.price_btc);
          realizedBtc += realized;
        }
        
        // Update position and average cost
        if (newPosition > 0) {
          avgCost = (position * avgCost + Math.abs(signedQty) * trade.price_btc) / newPosition;
        } else if (newPosition < 0) {
          avgCost = trade.price_btc;
        }
        
        position = newPosition;
        feesBtc += trade.fee_btc;
      });

      byInstrument[instrument] = {
        realizedBtc,
        feesBtc,
        currentPosition: position,
        avgCost
      };
      
      totalRealizedBtc += realizedBtc;
      totalFeesBtc += feesBtc;
    });

    return {
      totalRealizedBtc,
      totalFeesBtc,
      byInstrument,
      totalRealizedUsd: totalRealizedBtc * mockPnLParams.index_usd
    };
  }, []);

  // Calculate unrealized P&L
  const unrealizedPnL = useMemo(() => {
    let totalUnrealizedBtc = 0;
    const byInstrument = {};

    Object.entries(realizedPnL.byInstrument).forEach(([instrument, data]) => {
      if (data.currentPosition !== 0) {
        const currentMark = mockCurrentMarks[instrument] || 0;
        const unrealizedBtc = data.currentPosition * (currentMark - data.avgCost);
        
        byInstrument[instrument] = {
          position: data.currentPosition,
          avgCost: data.avgCost,
          currentMark,
          unrealizedBtc
        };
        
        totalUnrealizedBtc += unrealizedBtc;
      }
    });

    return {
      totalUnrealizedBtc,
      byInstrument,
      totalUnrealizedUsd: totalUnrealizedBtc * mockPnLParams.index_usd
    };
  }, [realizedPnL]);

  // Calculate attribution (simplified)
  const attribution = useMemo(() => {
    // Simplified attribution - in real app, would use yesterday's close vs today's open
    const priceMove = 0.02; // 2% F move
    const volMove = 0.01; // 1% vol move
    const timeDecay = -0.001; // Daily theta
    
    return {
      priceMoveBtc: priceMove * 0.1, // Simplified
      volMoveBtc: volMove * 0.05, // Simplified
      timeDecayBtc: timeDecay,
      carryFeesBtc: -0.0001 // Simplified
    };
  }, []);

  const Stat = ({ label, value, unit = "", highlight = false, positive = null }) => {
    const colorClass = positive !== null ? 
      (positive ? 'text-green-600' : 'text-red-600') : 
      (highlight ? 'text-blue-700' : 'text-gray-900');
    
    return (
      <div className={`p-3 rounded-lg ${highlight ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50'}`}>
        <div className="text-xs text-gray-500">{label}</div>
        <div className={`text-lg font-semibold ${colorClass}`}>{value}{unit}</div>
      </div>
    );
  };

  const formatNumber = (num, decimals = 4) => {
    if (Math.abs(num) < 0.0001) return num.toExponential(2);
    return num.toFixed(decimals);
  };

  return (
    <div className="space-y-6">
      {/* Top Metrics */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">P&L Summary</h3>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat 
            label="Realized P&L (BTC)" 
            value={formatNumber(realizedPnL.totalRealizedBtc, 6)} 
            unit="" 
            positive={realizedPnL.totalRealizedBtc > 0}
          />
          <Stat 
            label="Realized P&L (USD)" 
            value={`$${formatNumber(realizedPnL.totalRealizedUsd, 2)}`} 
            unit="" 
            positive={realizedPnL.totalRealizedUsd > 0}
          />
          <Stat 
            label="Unrealized P&L (BTC)" 
            value={formatNumber(unrealizedPnL.totalUnrealizedBtc, 6)} 
            unit="" 
            positive={unrealizedPnL.totalUnrealizedBtc > 0}
          />
          <Stat 
            label="Unrealized P&L (USD)" 
            value={`$${formatNumber(unrealizedPnL.totalUnrealizedUsd, 2)}`} 
            unit="" 
            positive={unrealizedPnL.totalUnrealizedUsd > 0}
          />
        </div>
        
        <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-4">
          <Stat 
            label="Total P&L (BTC)" 
            value={formatNumber(realizedPnL.totalRealizedBtc + unrealizedPnL.totalUnrealizedBtc, 6)} 
            unit="" 
            positive={(realizedPnL.totalRealizedBtc + unrealizedPnL.totalUnrealizedBtc) > 0}
            highlight
          />
          <Stat 
            label="Total P&L (USD)" 
            value={`$${formatNumber(realizedPnL.totalRealizedUsd + unrealizedPnL.totalUnrealizedUsd, 2)}`} 
            unit="" 
            positive={(realizedPnL.totalRealizedUsd + unrealizedPnL.totalUnrealizedUsd) > 0}
            highlight
          />
          <Stat 
            label="Total Fees (BTC)" 
            value={formatNumber(realizedPnL.totalFeesBtc, 6)} 
            unit="" 
            positive={false}
          />
        </div>
      </div>

      {/* Period Selection */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">P&L by Period</h3>
          <div className="flex space-x-2">
            <button
              className={`px-3 py-1 rounded-lg text-sm ${
                selectedPeriod === 'today' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'
              }`}
              onClick={() => setSelectedPeriod('today')}
            >
              Today
            </button>
            <button
              className={`px-3 py-1 rounded-lg text-sm ${
                selectedPeriod === 'ytd' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'
              }`}
              onClick={() => setSelectedPeriod('ytd')}
            >
              YTD
            </button>
          </div>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Day P&L (BTC)" value={formatNumber(0.0025, 6)} unit="" positive={true} />
          <Stat label="Day P&L (USD)" value={`$${formatNumber(278.62, 2)}`} unit="" positive={true} />
          <Stat label="YTD P&L (BTC)" value={formatNumber(0.0156, 6)} unit="" positive={true} />
          <Stat label="YTD P&L (USD)" value={`$${formatNumber(1738.57, 2)}`} unit="" positive={true} />
        </div>
      </div>

      {/* Attribution */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">Day P&L Attribution</h3>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat 
            label="Price (F move)" 
            value={formatNumber(attribution.priceMoveBtc, 6)} 
            unit="" 
            positive={attribution.priceMoveBtc > 0}
          />
          <Stat 
            label="Vol (σ move)" 
            value={formatNumber(attribution.volMoveBtc, 6)} 
            unit="" 
            positive={attribution.volMoveBtc > 0}
          />
          <Stat 
            label="Time (θ)" 
            value={formatNumber(attribution.timeDecayBtc, 6)} 
            unit="" 
            positive={attribution.timeDecayBtc > 0}
          />
          <Stat 
            label="Carry/Fees" 
            value={formatNumber(attribution.carryFeesBtc, 6)} 
            unit="" 
            positive={attribution.carryFeesBtc > 0}
          />
        </div>
        
        <div className="mt-4 text-xs text-gray-500">
          Attribution uses yesterday's close model & F as baseline
        </div>
      </div>

      {/* Realized P&L Details */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">Realized P&L by Instrument</h3>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Instrument</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Current Position</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Avg Cost (BTC)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Realized P&L (BTC)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Fees (BTC)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Net (BTC)</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {Object.entries(realizedPnL.byInstrument).map(([instrument, data]) => (
                <tr key={instrument}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{instrument}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{data.currentPosition}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(data.avgCost, 6)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(data.realizedBtc, 6)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(data.feesBtc, 6)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(data.realizedBtc - data.feesBtc, 6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Unrealized P&L Details */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">Unrealized P&L by Instrument</h3>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Instrument</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Position</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Avg Cost (BTC)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Current Mark (BTC)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Unrealized P&L (BTC)</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Unrealized P&L (USD)</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {Object.entries(unrealizedPnL.byInstrument).map(([instrument, data]) => (
                <tr key={instrument}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{instrument}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{data.position}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(data.avgCost, 6)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(data.currentMark, 6)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{formatNumber(data.unrealizedBtc, 6)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">${formatNumber(data.unrealizedBtc * mockPnLParams.index_usd, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* P&L Parameters */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">P&L Parameters</h3>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Mark Source</label>
            <select 
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={markSource}
              onChange={(e) => setMarkSource(e.target.value)}
            >
              <option value="MODEL">MODEL</option>
              <option value="MID">MID</option>
              <option value="LAST">LAST</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Index USD</label>
            <div className="text-lg font-semibold">${mockPnLParams.index_usd.toLocaleString()}</div>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">F (USD)</label>
            <div className="text-lg font-semibold">${mockPnLParams.F.toLocaleString()}</div>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Last Updated</label>
            <div className="text-sm text-gray-600">2024-01-16 15:30:00 UTC</div>
          </div>
        </div>
      </div>
    </div>
  );
}
