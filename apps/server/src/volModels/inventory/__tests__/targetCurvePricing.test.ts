/**
 * Gold Tests for Target Curve Pricing
 * Must-pass invariants for production use
 */

import {
  computeTargetCurvePricing,
  type TargetCurvePricingInput
} from '../targetCurvePricing';

describe('Target Curve Pricing - Gold Tests', () => {
  
  // ============================================================
  // Test 1: PC Anchoring
  // ============================================================
  test('should center quotes on PC mid (last fill price)', () => {
    const input: TargetCurvePricingInput = {
      ccMid: 10,
      pcMid: 10,
      currentPosition: 0,
      costPerLot: 0.01,
      minTick: 1,
      halfSpread: 1,
      policySize: 100
    };

    let quote = computeTargetCurvePricing(input);
    expect(quote.bid).toBe(9);
    expect(quote.ask).toBe(11);
    expect(quote.pcMid).toBe(10);

    // Simulate fill at 11 -> PC moves
    quote = computeTargetCurvePricing({
      ...input,
      pcMid: 11,
      currentPosition: -100
    });

    expect(quote.bid).toBe(10);
    expect(quote.ask).toBe(12);
    expect(quote.pcMid).toBe(11);
  });

  // ============================================================
  // Test 2: CC Immutability
  // ============================================================
  test('should not modify CC mid', () => {
    const ccMid = 10.6;
    const input: TargetCurvePricingInput = {
      ccMid,
      pcMid: 11,
      currentPosition: -40,
      costPerLot: 0.01,
      minTick: 1,
      halfSpread: 1,
      policySize: 100
    };

    computeTargetCurvePricing(input);
    expect(input.ccMid).toBe(ccMid);
  });

  // ============================================================
  // Test 3: Target Curve Math Q*(P) = -(P - CC) / r
  // ============================================================
  test('should compute correct target positions', () => {
    const input: TargetCurvePricingInput = {
      ccMid: 10.6,
      pcMid: 11,
      currentPosition: 0,
      costPerLot: 0.01,
      minTick: 1,
      halfSpread: 1,
      policySize: 100
    };

    const quote = computeTargetCurvePricing(input);

    // Q*(10) = -(10 - 10.6) / 0.01 = +60
    // Q*(12) = -(12 - 10.6) / 0.01 = -140
    expect(quote.diagnostics.targetAtBid).toBeCloseTo(60, 1);
    expect(quote.diagnostics.targetAtAsk).toBeCloseTo(-140, 1);
  });

  // ============================================================
  // Test 4: No Overfill
  // ============================================================
  test('should not overshoot target on single post', () => {
    const input: TargetCurvePricingInput = {
      ccMid: 0.0235,
      pcMid: 0.0236,
      currentPosition: -10,
      costPerLot: 0.00000197,
      minTick: 0.0001,
      halfSpread: 0.0001,
      policySize: 100
    };

    const quote = computeTargetCurvePricing(input);

    // Sizes should not exceed willingness
    expect(quote.bidSize).toBeLessThanOrEqual(
      quote.diagnostics.willingnessBid + 1
    );
    expect(quote.askSize).toBeLessThanOrEqual(
      quote.diagnostics.willingnessAsk + 1
    );
  });

  // ============================================================
  // Test 5: Tick Safety
  // ============================================================
  test('should never have bid >= ask', () => {
    const inputs: TargetCurvePricingInput[] = [
      {
        ccMid: 10,
        pcMid: 10,
        currentPosition: 0,
        costPerLot: 0.01,
        minTick: 1,
        halfSpread: 0.5,
        policySize: 100
      },
      {
        ccMid: 0.0235,
        pcMid: 0.0238,
        currentPosition: -50,
        costPerLot: 0.00000197,
        minTick: 0.0001,
        halfSpread: 0.0001,
        policySize: 100
      }
    ];

    inputs.forEach(input => {
      const quote = computeTargetCurvePricing(input);
      expect(quote.bid).toBeLessThan(quote.ask);
    });
  });

  // ============================================================
  // Test 6: r-Scaling
  // ============================================================
  test('sizes should scale inversely with r', () => {
    const base: TargetCurvePricingInput = {
      ccMid: 10.6,
      pcMid: 11,
      currentPosition: 0,
      costPerLot: 0.01,
      minTick: 1,
      halfSpread: 1,
      policySize: 1000
    };

    const quote1 = computeTargetCurvePricing(base);
    const quote2 = computeTargetCurvePricing({
      ...base,
      costPerLot: 0.02  // Double r
    });

    // Sizes should roughly halve
    expect(quote2.bidSize).toBeLessThan(quote1.bidSize * 0.6);
    expect(quote2.bidSize).toBeGreaterThan(quote1.bidSize * 0.4);
  });

  // ============================================================
  // Test 7: Capacity Caps
  // ============================================================
  test('should cap size when CC is close', () => {
    const input: TargetCurvePricingInput = {
      ccMid: 10.49,
      pcMid: 10.5,
      currentPosition: 0,
      costPerLot: 0.05,
      minTick: 1,
      halfSpread: 1,
      policySize: 100
    };

    const quote = computeTargetCurvePricing(input);

    // cap ≈ (10.49 - 9) / 0.05 ≈ 29.8
    expect(quote.bidSize).toBeLessThanOrEqual(30);
    expect(quote.bidSize).toBeLessThan(50);
  });

  // ============================================================
  // Test 8: Error Handling
  // ============================================================
  test('should throw on invalid r', () => {
    const input: TargetCurvePricingInput = {
      ccMid: 10,
      pcMid: 10,
      currentPosition: 0,
      costPerLot: 0,  // Invalid!
      minTick: 1,
      halfSpread: 1,
      policySize: 100
    };

    expect(() => computeTargetCurvePricing(input)).toThrow();
  });

  test('should handle zero position', () => {
    const input: TargetCurvePricingInput = {
      ccMid: 10,
      pcMid: 10,
      currentPosition: 0,
      costPerLot: 0.01,
      minTick: 1,
      halfSpread: 1,
      policySize: 100
    };

    const quote = computeTargetCurvePricing(input);
    expect(quote.bidSize).toBeGreaterThan(0);
    expect(quote.askSize).toBeGreaterThan(0);
  });
});
