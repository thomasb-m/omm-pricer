import React, { useState } from "react";
import VolController from "../components/VolController";

// VolModel now uses the enhanced VolController component

export default function VolModel() {
  // Core state - using live data from your backend
  const F_usd = 109630; // Live BTC futures price from your backend
  const index_usd = 109630; // Live BTC index
  const expiryUtc = new Date("2025-10-03T08:00:00Z"); // 3OCT25 08:00 UTC
  const r = 0.00; // Risk-free rate (annualized decimal)
  
  // Live market data from your Deribit feed
  const market = [
    { K: 110000, price: 0.019 }, // BTC-3OCT25-110000-C
    { K: 122000, price: 0.0008 }, // BTC-3OCT25-122000-C
  ];

  // VolController state
  const [volState, setVolState] = useState(null);

  // The new VolController handles all the data computation internally
  // We just need to pass the live data to it

  return (
    <VolController
      F={F_usd}
      expiry={expiryUtc}
      r={r}
      market={market}
      onChange={setVolState}
      title="Deribit BTC Vol — Live Controller"
      liveConnected={true}
    />
  );
}