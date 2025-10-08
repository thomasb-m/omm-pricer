"use strict";
/**
 * Model Configuration
 * Centralized config for the dual surface model
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefaultConfig = getDefaultConfig;
exports.validateConfig = validateConfig;
/**
 * Get default configuration for a product
 */
function getDefaultConfig(product = 'BTC') {
    // Product-specific adjustments
    const productMultipliers = {
        BTC: { edge: 1.0, risk: 1.0 },
        ETH: { edge: 1.2, risk: 1.2 },
        SPX: { edge: 0.5, risk: 0.8 }
    };
    const mult = productMultipliers[product];
    return {
        svi: {
            bMin: 1e-6,
            sigmaMin: 1e-3,
            rhoMax: 0.995,
            slopeMax: 2.0,
            c0Min: 1e-4
        },
        buckets: [
            {
                name: 'atm',
                minDelta: 0.45,
                maxDelta: 0.55,
                edgeParams: {
                    E0: 2.0 * mult.edge,
                    kappa: 5.0 * mult.edge,
                    gamma: 1.5,
                    Vref: 20.0
                }
            },
            {
                name: 'rr25',
                minDelta: 0.20,
                maxDelta: 0.30,
                edgeParams: {
                    E0: 1.0 * mult.edge,
                    kappa: 3.0 * mult.edge,
                    gamma: 1.4,
                    Vref: 30.0
                }
            },
            {
                name: 'rr10',
                minDelta: 0.08,
                maxDelta: 0.12,
                edgeParams: {
                    E0: 0.5 * mult.edge,
                    kappa: 2.0 * mult.edge,
                    gamma: 1.3,
                    Vref: 40.0
                }
            },
            {
                name: 'wings',
                minDelta: 0.00,
                maxDelta: 0.08,
                edgeParams: {
                    E0: 0.3 * mult.edge,
                    kappa: 1.5 * mult.edge,
                    gamma: 1.2,
                    Vref: 50.0
                }
            }
        ],
        rbf: {
            width: 0.15,
            ridgeLambda: 1e-3
        },
        riskLimits: {
            maxL0Move: 0.5 * mult.risk,
            maxS0Move: 0.2 * mult.risk,
            maxC0Move: 0.05 * mult.risk
        },
        inventory: {
            hysteresis: 0.2,
            minTradesForUpdate: 1
        },
        quotes: {
            minSpread: 0.5,
            touchPremium: 0.2,
            sizeBlocks: 100,
            staleHours: 24
        }
    };
}
/**
 * Validate configuration
 */
function validateConfig(config) {
    const errors = [];
    // Check SVI bounds
    if (config.svi.rhoMax >= 1) {
        errors.push('rhoMax must be < 1');
    }
    // Check buckets don't overlap
    for (let i = 0; i < config.buckets.length - 1; i++) {
        for (let j = i + 1; j < config.buckets.length; j++) {
            const b1 = config.buckets[i];
            const b2 = config.buckets[j];
            if (!(b1.maxDelta < b2.minDelta || b2.maxDelta < b1.minDelta)) {
                errors.push(`Buckets ${b1.name} and ${b2.name} overlap`);
            }
        }
    }
    // Check edge parameters
    for (const bucket of config.buckets) {
        if (bucket.edgeParams.gamma < 1) {
            errors.push(`Bucket ${bucket.name} has gamma < 1 (must be convex)`);
        }
        if (bucket.edgeParams.Vref <= 0) {
            errors.push(`Bucket ${bucket.name} has invalid Vref`);
        }
    }
    return {
        valid: errors.length === 0,
        errors
    };
}
