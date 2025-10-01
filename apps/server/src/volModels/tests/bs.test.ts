// apps/server/src/volModels/tests/bs.test.ts
import { blackScholes, DeltaConventions } from "../pricing/blackScholes";

function sanityCheck() {
  const call = blackScholes({
    strike: 100,
    spot: 100,
    vol: 0.2,
    T: 1,
    r: 0.0,
    isCall: true
  });

  console.log("ATM Call (S=100, K=100, vol=20%, T=1yr):");
  console.log(`  Price ≈ ${call.price.toFixed(2)} (should be ~7.97)`);
  console.log(`  Delta ≈ ${call.delta.toFixed(3)} (should be ~0.54)`);
  console.log(`  Vega  ≈ ${call.vega.toFixed(2)} (should be ~39.89)`);
  console.log(`  Theta ≈ ${call.theta.toFixed(2)} (should be ~-3.99)`);

  console.log("Bucket test:", DeltaConventions.strikeToBucket(100, 100, 0.2, 1));
}

sanityCheck();
