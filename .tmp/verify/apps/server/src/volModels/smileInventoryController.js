"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SmileInventoryController = void 0;
/**
 * Smile-based Inventory Controller
 * Expects **DEALER-signed** size in updateInventory(size).
 * We accumulate bucket vega as: inv.vega += size * option_vega.
 */
const dualSurfaceModel_1 = require("./dualSurfaceModel");
class SmileInventoryController {
    inventory;
    config;
    constructor(config) {
        this.config = config;
        this.inventory = new Map();
    }
    /** Update inventory after trade — expects DEALER-signed size */
    updateInventory(strike, size, vega, bucket) {
        const s = Number(size) || 0;
        const v = Number(vega) || 0;
        let bucketInv = this.inventory.get(bucket);
        if (!bucketInv) {
            bucketInv = { vega: 0, count: 0, strikes: [], edgeRequired: 0 };
            this.inventory.set(bucket, bucketInv);
        }
        const deltaV = s * v;
        bucketInv.vega = (Number(bucketInv.vega) || 0) + deltaV;
        bucketInv.count = (Number(bucketInv.count) || 0) + 1;
        if (!bucketInv.strikes.includes(strike))
            bucketInv.strikes.push(strike);
        // 🔎 Debug
        console.log(`[SIC.updateInv] bucket=${bucket} strike=${strike} size(dealer)=${s} vega=${v} Δvega=${deltaV} agg=${bucketInv.vega}`);
    }
    /** Map inventory to smile parameter adjustments */
    calculateSmileAdjustments() {
        let deltaL0 = 0, deltaS0 = 0, deltaC0 = 0, deltaSNeg = 0, deltaSPos = 0;
        for (const [bucket, inv] of this.inventory) {
            const bucketVega = Number(inv.vega) || 0;
            if (Math.abs(bucketVega) < 1e-9)
                continue;
            const cfg = this.config.buckets.find(b => b.name === bucket);
            if (!cfg)
                continue;
            const E0 = Number(cfg.edgeParams?.E0) || 0;
            const kappa = Number(cfg.edgeParams?.kappa) || 0;
            const gamma = Number(cfg.edgeParams?.gamma) || 1;
            const Vref = Math.max(Number(cfg.edgeParams?.Vref) || 1, 1e-6);
            const normalized = Math.abs(bucketVega) / Vref;
            // Negative for SHORT (bucketVega < 0) -> wants higher prices
            const edgeRequired = -Math.sign(bucketVega) * (E0 + kappa * Math.pow(normalized, gamma));
            inv.edgeRequired = edgeRequired;
            const TICK_TO_VOL = 0.005;
            switch (bucket) {
                case 'atm':
                    deltaL0 += edgeRequired * TICK_TO_VOL * 1.0;
                    deltaC0 += Math.sign(bucketVega) * Math.abs(edgeRequired) * 0.0001;
                    break;
                case 'rr25':
                    if (bucketVega < 0) {
                        deltaS0 += Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
                        deltaSNeg += -Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
                        deltaL0 += Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
                    }
                    else {
                        deltaS0 -= Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
                        deltaSNeg -= -Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
                        deltaL0 -= Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
                    }
                    break;
                case 'rr10':
                    if (bucketVega < 0) {
                        deltaSNeg += -Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
                        deltaS0 += Math.abs(edgeRequired) * TICK_TO_VOL * 0.15;
                    }
                    else {
                        deltaSNeg -= -Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
                        deltaS0 -= Math.abs(edgeRequired) * TICK_TO_VOL * 0.15;
                    }
                    break;
                case 'wings':
                    deltaL0 += edgeRequired * TICK_TO_VOL * 0.1;
                    deltaSNeg += -edgeRequired * TICK_TO_VOL * 0.4;
                    deltaS0 += edgeRequired * TICK_TO_VOL * 0.1;
                    break;
            }
        }
        return { deltaL0, deltaS0, deltaC0, deltaSNeg, deltaSPos };
    }
    /** Create PC from CC with backoff */
    adjustSVIForInventory(ccParams) {
        const base = dualSurfaceModel_1.SVI.toMetrics(ccParams);
        const adj = this.calculateSmileAdjustments();
        const make = (scale) => {
            const m = {
                L0: Math.max(0.001, base.L0 + adj.deltaL0 * scale),
                S0: base.S0 + adj.deltaS0 * scale,
                C0: Math.max(0.1, base.C0 + adj.deltaC0 * scale),
                S_neg: base.S_neg + adj.deltaSNeg * scale,
                S_pos: base.S_pos + adj.deltaSPos * scale,
            };
            return dualSurfaceModel_1.SVI.fromMetrics(m, this.createSVIConfig());
        };
        let pc = make(1.0);
        if (!dualSurfaceModel_1.SVI.validate(pc, this.createSVIConfig())) {
            let s = 0.5;
            while (s > 1e-3) {
                pc = make(s);
                if (dualSurfaceModel_1.SVI.validate(pc, this.createSVIConfig()))
                    break;
                s *= 0.5;
            }
            if (!dualSurfaceModel_1.SVI.validate(pc, this.createSVIConfig())) {
                console.warn('Adjusted SVI invalid; using CC.');
                return ccParams;
            }
        }
        return pc;
    }
    createSVIConfig() {
        return {
            bMin: this.config.svi.bMin,
            sigmaMin: this.config.svi.sigmaMin,
            rhoMax: this.config.svi.rhoMax,
            sMax: this.config.svi.slopeMax,
            c0Min: this.config.svi.c0Min,
            buckets: [],
            edgeParams: new Map(),
            rbfWidth: 0,
            ridgeLambda: 0,
            maxL0Move: 0,
            maxS0Move: 0,
            maxC0Move: 0
        };
    }
    getInventoryState() {
        return new Map(this.inventory);
    }
    getInventory() {
        const total = { vega: 0, gamma: 0, theta: 0 };
        const byBucket = {};
        for (const [bucket, inv] of this.inventory) {
            const v = Number(inv.vega) || 0;
            total.vega += v;
            byBucket[bucket] = { vega: v, count: inv.count };
        }
        return { total, totalVega: total.vega, byBucket, smileAdjustments: this.calculateSmileAdjustments() };
    }
    clearInventory() { this.inventory.clear(); }
}
exports.SmileInventoryController = SmileInventoryController;
