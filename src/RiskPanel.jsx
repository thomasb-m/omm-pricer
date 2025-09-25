import React, { useEffect, useState } from "react";

const API = (path) => `http://localhost:3001${path}`;

export default function RiskPanel() {
  const [risk, setRisk] = useState(null);
  const [positions, setPositions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [denom, setDenom] = useState("USD");

  async function load() {
    const r = await fetch(API("/pnl")).then(r=>r.json());
    setRisk(r);
    setDenom((r?.denom) || (process.env.PNL_DENOM || "USD"));
    // derive editable positions from legs (instrument + current qty/avg guess)
    const rows = (await fetch(API("/instruments")).then(r=>r.json()))
      .filter(x => r.legs.find(l => l.instrument === x.id));
    const mapped = rows.map(x => {
      const leg = r.legs.find(l => l.instrument === x.id);
      return { instrument: x.id, qty: leg?.qty ?? 0, avgPrice: Math.max(0, (leg?.mid ?? 0)) };
    });
    setPositions(mapped);
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  const updateField = (i, key, val) => {
    const next = [...positions];
    next[i] = { ...next[i], [key]: val };
    setPositions(next);
  };

  const save = async () => {
    setSaving(true);
    try {
      await fetch(API("/positions/set"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions })
      });
      await load();
    } finally { setSaving(false); }
  };

  return (
    <div className="p-4 rounded-2xl shadow border bg-white space-y-4">
      <h3 className="text-lg font-semibold">Risk & PnL</h3>

      {risk ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Metric label="Δ" value={risk.totals.delta.toFixed(2)} />
          <Metric label="Γ" value={risk.totals.gamma.toExponential(2)} />
          <Metric label="Vega" value={risk.totals.vega.toFixed(2)} />
          <Metric label={`Unrealized (${denom})`} value={risk.unrealized.toFixed(2)} />
        </div>
      ) : <div>Loading…</div>}

      <h4 className="font-medium">Positions</h4>
      <div className="space-y-2">
        {positions.map((p, i) => (
          <div key={p.instrument} className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <div className="text-sm truncate">{p.instrument}</div>
            <input
              className="border rounded p-2"
              type="number" step="1" value={p.qty}
              onChange={e => updateField(i, "qty", parseFloat(e.target.value))}
            />
            <input
              className="border rounded p-2"
              type="number" step="0.00001" value={p.avgPrice}
              onChange={e => updateField(i, "avgPrice", parseFloat(e.target.value))}
            />
            <button className="rounded bg-black text-white px-3 py-2" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="p-3 rounded-xl bg-gray-50">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

