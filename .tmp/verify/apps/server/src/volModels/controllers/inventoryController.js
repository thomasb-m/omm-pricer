"use strict";
/**
 * Inventory Controller
 * Manages inventory-locked bumps for PC (Price Curve)
 * Bumps are deterministic functions of inventory - no time decay
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventoryController = exports.BumpSolver = exports.EdgeLadder = void 0;
exports.testInventoryController = testInventoryController;
const dualSurfaceModel_1 = require("../dualSurfaceModel");
const blackScholes_1 = require("../pricing/blackScholes");
/**
 * Calculate edge requirement from inventory
 */
class EdgeLadder {
    /**
     * Calculate required edge in ticks for a bucket
     */
    static calculateEdge(inventory, // Signed vega
    config, bucket) {
        const bucketConfig = config.buckets.find(b => b.name === bucket);
        if (!bucketConfig)
            return 0;
        const { E0, kappa, gamma, Vref } = bucketConfig.edgeParams;
        // Edge ladder formula: -sign(I) * (E0 + kappa * (|I|/Vref)^gamma)
        // Negative sign because: SHORT position → want PC > CC → positive edge
        const sign = -Math.sign(inventory);
        const normalized = Math.abs(inventory) / Vref;
        const edge = sign * (E0 + kappa * Math.pow(normalized, gamma));
        return edge;
    }
    /**
     * Calculate edge with size adjustment
     */
    static calculateEdgeWithSize(inventory, size, // Quote size
    config, bucket) {
        const baseEdge = this.calculateEdge(inventory, config, bucket);
        // Size adjustment (optional)
        const sizeRef = 100; // Reference size
        const sizeMultiplier = 1 + 0.2 * Math.pow(size / sizeRef, 1.2);
        return baseEdge * sizeMultiplier;
    }
}
exports.EdgeLadder = EdgeLadder;
/**
 * Convert edge to variance bumps
 */
class BumpSolver {
    /**
     * Convert cash edge to variance target
     */
    static edgeToVarianceTarget(edge, // In ticks
    k, // Log-moneyness
    cc, // Core surface
    T, // Time to expiry
    spot, tickValue = 0.01) {
        // Get core IV at this strike
        const variance = dualSurfaceModel_1.SVI.w(cc, k);
        const iv = blackScholes_1.PriceVolConverter.varianceToIV(variance, T);
        // Calculate vega at this point
        const strike = spot * Math.exp(k);
        const greeks = (0, blackScholes_1.blackScholes)({
            strike,
            spot,
            vol: iv,
            T,
            r: 0,
            isCall: false
        });
        // Convert edge in ticks to price units
        // For options, 1 tick = tickValue of the option price
        const priceEdge = edge * tickValue;
        // Convert price edge to variance adjustment
        // Using vega: dPrice/dVol ≈ vega, so dVol ≈ dPrice/vega
        // But we need variance, not vol: dVariance = 2*σ*T*dVol
        const volChange = priceEdge / Math.max(greeks.vega, 0.1);
        const deltaW = 2 * iv * T * volChange / 100; // Divide by 100 as vega is per 1% move
        return deltaW;
    }
    /**
     * Solve for RBF amplitudes given targets
     */
    static solveForBumps(targets, centers, width = 0.15, ridgeLambda = 1e-3) {
        const n = targets.length;
        const m = centers.length;
        // Build design matrix (Φ)
        const phi = [];
        const y = [];
        for (let i = 0; i < n; i++) {
            phi[i] = [];
            for (let j = 0; j < m; j++) {
                // Gaussian RBF
                const dist = (targets[i].k - centers[j]) / width;
                phi[i][j] = Math.exp(-0.5 * dist * dist);
            }
            y[i] = targets[i].deltaW;
        }
        // Ridge regression: (Φ'Φ + λI)α = Φ'y
        // Simplified solver - in production use proper linear algebra library
        const alphas = this.ridgeRegression(phi, y, ridgeLambda);
        return alphas;
    }
    /**
     * Simple ridge regression solver
     */
    static ridgeRegression(X, y, lambda) {
        const n = X.length;
        const m = X[0].length;
        // Compute X'X
        const XtX = [];
        for (let i = 0; i < m; i++) {
            XtX[i] = [];
            for (let j = 0; j < m; j++) {
                let sum = 0;
                for (let k = 0; k < n; k++) {
                    sum += X[k][i] * X[k][j];
                }
                XtX[i][j] = sum + (i === j ? lambda : 0); // Add ridge
            }
        }
        // Compute X'y
        const Xty = [];
        for (let i = 0; i < m; i++) {
            let sum = 0;
            for (let k = 0; k < n; k++) {
                sum += X[k][i] * y[k];
            }
            Xty[i] = sum;
        }
        // Solve using Gaussian elimination (simplified)
        // In production, use a proper linear algebra library
        return this.gaussianElimination(XtX, Xty);
    }
    /**
     * Gaussian elimination solver
     */
    static gaussianElimination(A, b) {
        const n = b.length;
        const augmented = [];
        // Create augmented matrix
        for (let i = 0; i < n; i++) {
            augmented[i] = [...A[i], b[i]];
        }
        // Forward elimination
        for (let i = 0; i < n; i++) {
            // Partial pivoting
            let maxRow = i;
            for (let k = i + 1; k < n; k++) {
                if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) {
                    maxRow = k;
                }
            }
            [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];
            // Make all rows below this one 0 in current column
            for (let k = i + 1; k < n; k++) {
                const factor = augmented[k][i] / augmented[i][i];
                for (let j = i; j <= n; j++) {
                    augmented[k][j] -= factor * augmented[i][j];
                }
            }
        }
        // Back substitution
        const x = new Array(n).fill(0);
        for (let i = n - 1; i >= 0; i--) {
            x[i] = augmented[i][n];
            for (let j = i + 1; j < n; j++) {
                x[i] -= augmented[i][j] * x[j];
            }
            x[i] /= augmented[i][i];
        }
        return x;
    }
}
exports.BumpSolver = BumpSolver;
/**
 * Main inventory controller
 */
class InventoryController {
    inventory;
    config;
    lastBumpUpdate;
    constructor(config) {
        this.config = config;
        this.inventory = {
            byBucket: new Map(),
            byStrike: new Map(),
            totalVega: 0
        };
        this.lastBumpUpdate = new Map();
    }
    /**
     * Update inventory after a trade
     */
    updateInventory(strike, size, // Positive = bought, negative = sold
    vega, bucket) {
        // Update strike-level inventory
        const currentPos = this.inventory.byStrike.get(strike) || 0;
        this.inventory.byStrike.set(strike, currentPos + size);
        // Update bucket inventory
        let bucketInv = this.inventory.byBucket.get(bucket);
        if (!bucketInv) {
            bucketInv = {
                bucket,
                signedVega: 0,
                count: 0,
                lastUpdate: Date.now()
            };
            this.inventory.byBucket.set(bucket, bucketInv);
        }
        bucketInv.signedVega += size * vega; // size is signed
        bucketInv.count += 1;
        bucketInv.lastUpdate = Date.now();
        // Update total
        this.inventory.totalVega += size * vega;
    }
    /**
     * Check if bumps need updating (hysteresis)
     */
    needsBumpUpdate(bucket) {
        const bucketInv = this.inventory.byBucket.get(bucket);
        if (!bucketInv)
            return false;
        const lastUpdate = this.lastBumpUpdate.get(bucket) || 0;
        const timeSinceUpdate = Date.now() - lastUpdate;
        // Update if:
        // 1. Never updated
        // 2. Significant inventory change (hysteresis)
        // 3. Enough trades accumulated
        const bucketConfig = this.config.buckets.find(b => b.name === bucket);
        if (!bucketConfig)
            return false;
        const threshold = bucketConfig.edgeParams.Vref * this.config.inventory.hysteresis;
        const vegaChange = Math.abs(bucketInv.signedVega);
        return (lastUpdate === 0 ||
            vegaChange > threshold ||
            bucketInv.count >= this.config.inventory.minTradesForUpdate);
    }
    /**
     * Generate bumps for a bucket
     */
    generateBumps(bucket, cc, T, spot, strikes // Representative strikes for this bucket
    ) {
        const bucketInv = this.inventory.byBucket.get(bucket);
        if (!bucketInv || Math.abs(bucketInv.signedVega) < 1e-6) {
            return [];
        }
        // Calculate required edge
        const edge = EdgeLadder.calculateEdge(bucketInv.signedVega, this.config, bucket);
        if (Math.abs(edge) < 0.01) {
            return [];
        }
        // Create targets at representative strikes
        const targets = [];
        const centers = [];
        for (const strike of strikes) {
            const k = Math.log(strike / spot);
            const deltaW = BumpSolver.edgeToVarianceTarget(edge, k, cc, T, spot);
            targets.push({ k, deltaW });
            centers.push(k);
        }
        // Solve for amplitudes
        const alphas = BumpSolver.solveForBumps(targets, centers, this.config.rbf.width, this.config.rbf.ridgeLambda);
        // Create bumps - use tighter width for better localization
        const bumps = [];
        for (let i = 0; i < centers.length; i++) {
            if (Math.abs(alphas[i]) > 1e-6) {
                bumps.push({
                    k: centers[i],
                    alpha: alphas[i],
                    lam: this.config.rbf.width * 0.5, // Use half the configured width for tighter bumps
                    bucket
                });
            }
        }
        // Mark update time
        this.lastBumpUpdate.set(bucket, Date.now());
        return bumps;
    }
    /**
     * Rebase bumps when CC moves
     */
    rebaseBumps(oldCC, newCC, existingBumps, T, spot) {
        // Group bumps by bucket
        const bumpsByBucket = new Map();
        for (const bump of existingBumps) {
            const bucketBumps = bumpsByBucket.get(bump.bucket) || [];
            bucketBumps.push(bump);
            bumpsByBucket.set(bump.bucket, bucketBumps);
        }
        // Rebase each bucket
        const newBumps = [];
        for (const [bucket, oldBumps] of bumpsByBucket) {
            const bucketInv = this.inventory.byBucket.get(bucket);
            if (!bucketInv)
                continue;
            // Get strikes from old bumps
            const strikes = oldBumps.map(b => spot * Math.exp(b.k));
            // Generate new bumps with same edge requirement but new CC
            const rebasedBumps = this.generateBumps(bucket, newCC, T, spot, strikes);
            newBumps.push(...rebasedBumps);
        }
        return newBumps;
    }
    /**
     * Get current inventory state
     */
    getInventoryState() {
        return { ...this.inventory };
    }
    /**
     * Clear inventory for a bucket
     */
    clearBucket(bucket) {
        this.inventory.byBucket.delete(bucket);
        this.lastBumpUpdate.delete(bucket);
    }
    /**
     * Get edge requirement for current inventory
     */
    getCurrentEdge(bucket) {
        const bucketInv = this.inventory.byBucket.get(bucket);
        if (!bucketInv)
            return 0;
        return EdgeLadder.calculateEdge(bucketInv.signedVega, this.config, bucket);
    }
}
exports.InventoryController = InventoryController;
/**
 * Test the inventory controller
 */
function testInventoryController() {
    console.log('Testing Inventory Controller...\n');
    const config = {
        buckets: [{
                name: 'rr25',
                minDelta: 0.20,
                maxDelta: 0.30,
                edgeParams: {
                    E0: 1.0,
                    kappa: 3.0,
                    gamma: 1.4,
                    Vref: 100.0
                }
            }],
        rbf: {
            width: 0.15,
            ridgeLambda: 1e-3
        },
        inventory: {
            hysteresis: 0.2,
            minTradesForUpdate: 1
        }
    };
    const controller = new InventoryController(config);
    // Simulate selling 100 lots
    controller.updateInventory(95, -100, 0.5, 'rr25');
    const edge = controller.getCurrentEdge('rr25');
    console.log(`After selling 100 lots:`);
    console.log(`  Inventory: -50 vega`);
    console.log(`  Required edge: ${edge.toFixed(2)} ticks`);
    console.log(`  Direction: ${edge > 0 ? 'PC > CC (discourage selling)' : 'PC < CC'}`);
    // Generate bumps
    const cc = {
        a: 0.03,
        b: 0.5,
        rho: -0.2,
        sigma: 0.2,
        m: 0
    };
    const bumps = controller.generateBumps('rr25', cc, 0.25, 100, [95]);
    console.log(`\nGenerated ${bumps.length} bump(s)`);
    if (bumps.length > 0) {
        console.log(`  Bump at k=${bumps[0].k.toFixed(3)}, alpha=${bumps[0].alpha.toFixed(4)}`);
    }
}
