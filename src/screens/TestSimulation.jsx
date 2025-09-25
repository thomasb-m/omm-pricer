import React, { useState, useMemo } from 'react';

// Mock current book data
const mockCurrentBook = {
  totalDelta: 0.25,
  totalGamma: 0.0001,
  totalVega: 0.05,
  totalTheta: -0.001,
  totalPv: 0.125
};

// Available instruments for simulation
const availableInstruments = [
  "BTC-3OCT25-110000-C",
  "BTC-3OCT25-111000-C", 
  "BTC-3OCT25-112000-C",
  "BTC-3OCT25-110000-P",
  "BTC-3OCT25-111000-P",
  "BTC-3OCT25-112000-P"
];

export default function TestSimulation() {
  // Simulation state
  const [simPositions, setSimPositions] = useState([]);
  const [scenarios, setScenarios] = useState({
    dF_usd: 0,
    dSigma_bps: 0,
    skew_bps_per_k: 0,
    dt_days: 0
  });
  const [compareMode, setCompareMode] = useState('current'); // 'current' | 'book+sim'
  const [scenarioId, setScenarioId] = useState('scenario_1');

  // Add simulated position
  const addSimPosition = () => {
    const newPosition = {
      id: Date.now(),
      instrument: availableInstruments[0],
      side: 'LONG',
      qty: 1
    };
    setSimPositions([...simPositions, newPosition]);
  };

  // Remove simulated position
  const removeSimPosition = (id) => {
    setSimPositions(simPositions.filter(pos => pos.id !== id));
  };

  // Update simulated position
  const updateSimPosition = (id, field, value) => {
    setSimPositions(simPositions.map(pos => 
      pos.id === id ? { ...pos, [field]: value } : pos
    ));
  };

  // Calculate simulation results
  const simulationResults = useMemo(() => {
    if (simPositions.length === 0) {
      return {
        delta: 0,
        gamma: 0,
        vega: 0,
        theta: 0,
        pv: 0
      };
    }

    // Simplified calculation - in real app, would use actual pricing
    const totalDelta = simPositions.reduce((sum, pos) => {
      const signedQty = pos.side === 'LONG' ? pos.qty : -pos.qty;
      return sum + (signedQty * 0.5); // Simplified delta
    }, 0);

    const totalGamma = simPositions.reduce((sum, pos) => {
      const signedQty = pos.side === 'LONG' ? pos.qty : -pos.qty;
      return sum + (signedQty * 0.0001); // Simplified gamma
    }, 0);

    const totalVega = simPositions.reduce((sum, pos) => {
      const signedQty = pos.side === 'LONG' ? pos.qty : -pos.qty;
      return sum + (signedQty * 0.05); // Simplified vega
    }, 0);

    const totalTheta = simPositions.reduce((sum, pos) => {
      const signedQty = pos.side === 'LONG' ? pos.qty : -pos.qty;
      return sum + (signedQty * -0.001); // Simplified theta
    }, 0);

    const totalPv = simPositions.reduce((sum, pos) => {
      const signedQty = pos.side === 'LONG' ? pos.qty : -pos.qty;
      return sum + (signedQty * 0.0125); // Simplified PV
    }, 0);

    return {
      delta: totalDelta,
      gamma: totalGamma,
      vega: totalVega,
      theta: totalTheta,
      pv: totalPv
    };
  }, [simPositions]);

  // Calculate scenario P&L
  const scenarioPnL = useMemo(() => {
    const { dF_usd, dSigma_bps, skew_bps_per_k, dt_days } = scenarios;
    
    // Simplified scenario P&L calculation
    const deltaPnL = mockCurrentBook.totalDelta * (dF_usd / 100000); // Simplified
    const gammaPnL = mockCurrentBook.totalGamma * Math.pow(dF_usd / 100000, 2) * 0.5;
    const vegaPnL = mockCurrentBook.totalVega * (dSigma_bps / 10000);
    const thetaPnL = mockCurrentBook.totalTheta * dt_days;
    
    const totalPnLBtc = deltaPnL + gammaPnL + vegaPnL + thetaPnL;
    const totalPnLUsd = totalPnLBtc * 111447; // BTC index price
    
    return {
      deltaPnL,
      gammaPnL,
      vegaPnL,
      thetaPnL,
      totalPnLBtc,
      totalPnLUsd
    };
  }, [scenarios]);

  // Compare results
  const compareResults = useMemo(() => {
    if (compareMode === 'current') {
      return {
        delta: mockCurrentBook.totalDelta,
        gamma: mockCurrentBook.totalGamma,
        vega: mockCurrentBook.totalVega,
        theta: mockCurrentBook.totalTheta,
        pv: mockCurrentBook.totalPv
      };
    } else {
      return {
        delta: mockCurrentBook.totalDelta + simulationResults.delta,
        gamma: mockCurrentBook.totalGamma + simulationResults.gamma,
        vega: mockCurrentBook.totalVega + simulationResults.vega,
        theta: mockCurrentBook.totalTheta + simulationResults.theta,
        pv: mockCurrentBook.totalPv + simulationResults.pv
      };
    }
  }, [compareMode, simulationResults]);

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
      {/* Simulation Controls */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">Simulation Controls</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Add Simulated Positions */}
          <div>
            <h4 className="font-medium mb-3">Add Simulated Positions</h4>
            <button
              onClick={addSimPosition}
              className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg text-sm font-medium mb-4"
            >
              Add Position
            </button>
            
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {simPositions.map((pos) => (
                <div key={pos.id} className="flex items-center space-x-2 p-2 bg-gray-50 rounded-lg">
                  <select
                    className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                    value={pos.instrument}
                    onChange={(e) => updateSimPosition(pos.id, 'instrument', e.target.value)}
                  >
                    {availableInstruments.map(inst => (
                      <option key={inst} value={inst}>{inst}</option>
                    ))}
                  </select>
                  
                  <select
                    className="rounded border border-gray-300 px-2 py-1 text-sm"
                    value={pos.side}
                    onChange={(e) => updateSimPosition(pos.id, 'side', e.target.value)}
                  >
                    <option value="LONG">LONG</option>
                    <option value="SHORT">SHORT</option>
                  </select>
                  
                  <input
                    type="number"
                    className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
                    value={pos.qty}
                    onChange={(e) => updateSimPosition(pos.id, 'qty', parseInt(e.target.value) || 0)}
                    min="1"
                  />
                  
                  <button
                    onClick={() => removeSimPosition(pos.id)}
                    className="text-red-600 hover:text-red-800 text-sm"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Scenarios */}
          <div>
            <h4 className="font-medium mb-3">Scenario Parameters</h4>
            
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">ΔF (USD)</label>
                <input
                  type="number"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  value={scenarios.dF_usd}
                  onChange={(e) => setScenarios({...scenarios, dF_usd: parseFloat(e.target.value) || 0})}
                  step="100"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Vol Shift (bps)</label>
                <input
                  type="number"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  value={scenarios.dSigma_bps}
                  onChange={(e) => setScenarios({...scenarios, dSigma_bps: parseFloat(e.target.value) || 0})}
                  step="10"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Skew (bps per k)</label>
                <input
                  type="number"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  value={scenarios.skew_bps_per_k}
                  onChange={(e) => setScenarios({...scenarios, skew_bps_per_k: parseFloat(e.target.value) || 0})}
                  step="1"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Time Roll (days)</label>
                <input
                  type="number"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  value={scenarios.dt_days}
                  onChange={(e) => setScenarios({...scenarios, dt_days: parseFloat(e.target.value) || 0})}
                  step="0.1"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Compare Mode */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">Compare Mode</h3>
        
        <div className="flex space-x-4 mb-4">
          <button
            className={`px-4 py-2 rounded-lg text-sm font-medium ${
              compareMode === 'current' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'
            }`}
            onClick={() => setCompareMode('current')}
          >
            Current Book
          </button>
          <button
            className={`px-4 py-2 rounded-lg text-sm font-medium ${
              compareMode === 'book+sim' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'
            }`}
            onClick={() => setCompareMode('book+sim')}
          >
            Book + Simulation
          </button>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Stat label="Δ (BTC)" value={formatNumber(compareResults.delta)} unit="" />
          <Stat label="Γ (per $)" value={formatNumber(compareResults.gamma)} unit="" />
          <Stat label="Vega (BTC/vol-pt)" value={formatNumber(compareResults.vega)} unit="" />
          <Stat label="Θ (BTC/day)" value={formatNumber(compareResults.theta)} unit="" />
          <Stat label="PV (BTC)" value={formatNumber(compareResults.pv, 6)} unit="" />
        </div>
      </div>

      {/* Scenario P&L */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">Scenario P&L</h3>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat 
            label="Δ P&L (F move)" 
            value={formatNumber(scenarioPnL.deltaPnL, 6)} 
            unit="" 
            positive={scenarioPnL.deltaPnL > 0}
          />
          <Stat 
            label="Γ P&L (F² move)" 
            value={formatNumber(scenarioPnL.gammaPnL, 6)} 
            unit="" 
            positive={scenarioPnL.gammaPnL > 0}
          />
          <Stat 
            label="Vega P&L (vol move)" 
            value={formatNumber(scenarioPnL.vegaPnL, 6)} 
            unit="" 
            positive={scenarioPnL.vegaPnL > 0}
          />
          <Stat 
            label="Θ P&L (time)" 
            value={formatNumber(scenarioPnL.thetaPnL, 6)} 
            unit="" 
            positive={scenarioPnL.thetaPnL > 0}
          />
        </div>
        
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Stat 
            label="Total P&L (BTC)" 
            value={formatNumber(scenarioPnL.totalPnLBtc, 6)} 
            unit="" 
            positive={scenarioPnL.totalPnLBtc > 0}
            highlight
          />
          <Stat 
            label="Total P&L (USD)" 
            value={`$${formatNumber(scenarioPnL.totalPnLUsd, 2)}`} 
            unit="" 
            positive={scenarioPnL.totalPnLUsd > 0}
            highlight
          />
        </div>
      </div>

      {/* Simulation Results */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">Simulation Results</h3>
        
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Stat label="Sim Δ (BTC)" value={formatNumber(simulationResults.delta)} unit="" />
          <Stat label="Sim Γ (per $)" value={formatNumber(simulationResults.gamma)} unit="" />
          <Stat label="Sim Vega (BTC/vol-pt)" value={formatNumber(simulationResults.vega)} unit="" />
          <Stat label="Sim Θ (BTC/day)" value={formatNumber(simulationResults.theta)} unit="" />
          <Stat label="Sim PV (BTC)" value={formatNumber(simulationResults.pv, 6)} unit="" />
        </div>
      </div>

      {/* Scenario Management */}
      <div className="bg-white p-4 rounded-lg shadow border">
        <h3 className="text-lg font-semibold mb-4">Scenario Management</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Scenario ID</label>
            <input
              type="text"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={scenarioId}
              onChange={(e) => setScenarioId(e.target.value)}
            />
          </div>
          
          <div className="flex items-end space-x-2">
            <button className="bg-green-600 text-white py-2 px-4 rounded-lg text-sm font-medium">
              Save Scenario
            </button>
            <button className="bg-gray-200 text-gray-700 py-2 px-4 rounded-lg text-sm font-medium">
              Recall Scenario
            </button>
          </div>
          
          <div className="text-sm text-gray-500">
            <div>Saved scenarios: 3</div>
            <div>Last saved: 2024-01-16 15:30:00</div>
          </div>
        </div>
      </div>

      {/* Sandbox Notice */}
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <div className="flex">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3">
            <h3 className="text-sm font-medium text-yellow-800">Sandbox Mode</h3>
            <div className="mt-1 text-sm text-yellow-700">
              This simulation does not affect your live book. All calculations are hypothetical and for testing purposes only.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
