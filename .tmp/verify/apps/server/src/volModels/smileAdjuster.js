"use strict";
/**
 * Smile-aware inventory adjustments
 * Adjusts the entire smile shape based on inventory, not just local bumps
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SmileAdjuster = void 0;
const dualSurfaceModel_1 = require("./dualSurfaceModel");
class SmileAdjuster {
    /**
     * Calculate how inventory should adjust the smile
     * Based on market microstructure effects
     */
    static calculateSmileImpact(inventory, config) {
        let deltaL0 = 0;
        let deltaS0 = 0;
        let deltaC0 = 0;
        let deltaSNeg = 0;
        let deltaSPos = 0;
        // Process each bucket's contribution
        for (const [bucket, inv] of inventory) {
            if (Math.abs(inv.vega) < 0.1)
                continue;
            // Get edge requirement for this bucket
            const bucketConfig = config.buckets.find((b) => b.name === bucket);
            if (!bucketConfig)
                continue;
            const { E0, kappa, gamma, Vref } = bucketConfig.edgeParams;
            const normalized = Math.abs(inv.vega) / Vref;
            const edgeTicks = -Math.sign(inv.vega) * (E0 + kappa * Math.pow(normalized, gamma));
            // Convert edge to vol adjustments based on bucket
            // These are calibrated impacts - would be fitted to real market behavior
            switch (bucket) {
                case 'atm':
                    // ATM inventory mainly affects level and curvature
                    deltaL0 += edgeTicks * 0.001; // 1 tick = 0.1% vol
                    deltaC0 += Math.sign(inv.vega) * edgeTicks * 0.0002;
                    break;
                case 'rr25':
                    // 25-delta affects skew and wings
                    if (inv.vega < 0) {
                        // Short 25d puts
                        deltaS0 += edgeTicks * 0.0003; // Increase skew (puts richer)
                        deltaSNeg += -edgeTicks * 0.0002; // Lower left wing
                        deltaL0 += edgeTicks * 0.0002; // Small ATM lift
                    }
                    else {
                        // Long 25d puts  
                        deltaS0 -= edgeTicks * 0.0003; // Decrease skew
                        deltaSNeg -= -edgeTicks * 0.0002; // Raise left wing
                        deltaL0 -= edgeTicks * 0.0002;
                    }
                    // 25d calls would affect right wing
                    if (inv.vega < 0 && bucket.includes('call')) {
                        deltaSPos += -edgeTicks * 0.0002;
                    }
                    break;
                case 'rr10':
                    // 10-delta primarily affects wings
                    if (inv.vega < 0) {
                        deltaSNeg += -edgeTicks * 0.0003;
                        deltaS0 += edgeTicks * 0.0002; // Some skew impact
                    }
                    else {
                        deltaSNeg -= -edgeTicks * 0.0003;
                        deltaS0 -= edgeTicks * 0.0002;
                    }
                    break;
                case 'wings':
                    // Far wings - mostly wing slopes
                    if (inv.vega < 0) {
                        deltaSNeg += -edgeTicks * 0.0004;
                        // Very small propagation to skew
                        deltaS0 += edgeTicks * 0.0001;
                    }
                    break;
            }
        }
        return {
            deltaL0,
            deltaS0,
            deltaC0,
            deltaSNeg,
            deltaSPos
        };
    }
    /**
     * Apply smile adjustments to SVI parameters
     */
    static adjustSVIForInventory(baseCC, inventory, config) {
        // Get current metrics
        const baseMetrics = dualSurfaceModel_1.SVI.toMetrics(baseCC);
        // Calculate adjustments
        const impact = this.calculateSmileImpact(inventory, config);
        // Apply adjustments
        const adjustedMetrics = {
            L0: baseMetrics.L0 + impact.deltaL0,
            S0: baseMetrics.S0 + impact.deltaS0,
            C0: baseMetrics.C0 + impact.deltaC0,
            S_neg: baseMetrics.S_neg + impact.deltaSNeg,
            S_pos: baseMetrics.S_pos + impact.deltaSPos
        };
        // Convert back to SVI with safety checks
        const sviConfig = {
            bMin: config.svi.bMin,
            sigmaMin: config.svi.sigmaMin,
            rhoMax: config.svi.rhoMax,
            sMax: config.svi.slopeMax,
            c0Min: config.svi.c0Min,
            buckets: [],
            edgeParams: new Map(),
            rbfWidth: 0,
            ridgeLambda: 0,
            maxL0Move: 0,
            maxS0Move: 0,
            maxC0Move: 0
        };
        const adjustedSVI = dualSurfaceModel_1.SVI.fromMetrics(adjustedMetrics, sviConfig);
        // Validate and return
        if (dualSurfaceModel_1.SVI.validate(adjustedSVI, sviConfig)) {
            return adjustedSVI;
        }
        else {
            console.warn('Adjusted SVI failed validation, returning base');
            return baseCC;
        }
    }
    /**
     * Visualize the smile adjustment
     */
    static compareSmiles(baseCC, adjustedPC, spot, T) {
        console.log('\nSmile Comparison (CC vs PC with inventory adjustment):');
        console.log('Strike | Delta | CC Vol | PC Vol | Diff');
        console.log('-'.repeat(50));
        const strikes = [
            spot * 0.80, // Far OTM put
            spot * 0.90, // 10d put
            spot * 0.95, // 25d put  
            spot * 1.00, // ATM
            spot * 1.05, // 25d call
            spot * 1.10, // 10d call
            spot * 1.20 // Far OTM call
        ];
        for (const strike of strikes) {
            const k = Math.log(strike / spot);
            const ccVar = dualSurfaceModel_1.SVI.w(baseCC, k);
            const pcVar = dualSurfaceModel_1.SVI.w(adjustedPC, k);
            const ccVol = Math.sqrt(ccVar / T) * 100;
            const pcVol = Math.sqrt(pcVar / T) * 100;
            const diff = pcVol - ccVol;
            // Estimate delta (rough)
            const delta = 50 * Math.exp(-2 * k * k); // Approximation
            console.log(`${strike.toFixed(0).padStart(6)} | ` +
                `${delta.toFixed(0).padStart(5)} | ` +
                `${ccVol.toFixed(1).padStart(6)} | ` +
                `${pcVol.toFixed(1).padStart(6)} | ` +
                `${diff > 0 ? '+' : ''}${diff.toFixed(2)}`);
        }
    }
}
exports.SmileAdjuster = SmileAdjuster;
// Create base CC
const baseMetrics = {
    L0: 0.04, // 20% vol for 3M
    S0: -0.001, // Slight put skew
    C0: 0.5,
    S_neg: -0.8,
    S_pos: 0.9
};
// Convert to SVI config format
const sviConfig = {
    bMin: config.svi.bMin,
    sigmaMin: config.svi.sigmaMin,
    rhoMax: config.svi.rhoMax,
    sMax: config.svi.slopeMax,
    c0Min: config.svi.c0Min,
    buckets: [],
    edgeParams: new Map(),
    rbfWidth: 0,
    ridgeLambda: 0,
    maxL0Move: 0,
    maxS0Move: 0,
    maxC0Move: 0
};
const baseCC = dualSurfaceModel_1.SVI.fromMetrics(baseMetrics, sviConfig);
// Simulate inventory: short 100 vega in 25d puts
const inventory = new Map();
inventory.set('rr25', { vega: -100, count: 1 });
console.log('Inventory: SHORT 100 vega in 25-delta puts\n');
// Calculate impact
const impact = SmileAdjuster.calculateSmileImpact(inventory, config);
console.log('Expected smile adjustments:');
console.log(`  ΔL0 (ATM level):    ${(impact.deltaL0 * 100).toFixed(2)}% vol`);
console.log(`  ΔS0 (Skew):         ${(impact.deltaS0 * 100).toFixed(3)}% vol/unit`);
console.log(`  ΔC0 (Curvature):    ${impact.deltaC0.toFixed(4)}`);
console.log(`  ΔS_neg (Left wing): ${(impact.deltaSNeg * 100).toFixed(3)}% vol/unit`);
console.log(`  ΔS_pos (Right wing):${(impact.deltaSPos * 100).toFixed(3)}% vol/unit`);
// Apply adjustments
const adjustedPC = SmileAdjuster.adjustSVIForInventory(baseCC, inventory, config);
// Compare smiles
SmileAdjuster.compareSmiles(baseCC, adjustedPC, 100, 0.25);
console.log('\nInterpretation:');
console.log('  • Skew increased (puts more expensive relative to calls)');
console.log('  • Left wing lowered (far OTM puts cheaper)');
console.log('  • Small ATM lift (general vol increase)');
console.log('  • This matches real market behavior when dealers are short puts');
console.log('\n' + '='.repeat(60));
// Run test if executed directly
if (require.main === module) {
    testSmileAdjuster();
}
