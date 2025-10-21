#!/usr/bin/env bash
set -euo pipefail
# COMMIT: fix(inv): numeric-safe inventory + non-null summaries

# Overwrite smileInventoryController with numeric guards + meaningful adjustments
cat > apps/server/src/volModels/smileInventoryController.ts <<'TS'
/**
 * Smile-based Inventory Controller
 * Adjusts entire smile shape based on inventory, not local bumps
 */

import { SVIParams, SVI, TraderMetrics } from './dualSurfaceModel';
import { ModelConfig } from './config/modelConfig';

export interface SmileAdjustments {
  deltaL0: number;
  deltaS0: number;
  deltaC0: number;
  deltaSNeg: number;
  deltaSPos: number;
}

export interface InventoryBucket {
  vega: number;
  count: number;
  strikes: number[];
  edgeRequired?: number;
}

export class SmileInventoryController {
  private inventory: Map<string, InventoryBucket>;
  private config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
    this.inventory = new Map();
  }

  /** Update inventory after trade (numeric-safe) */
  updateInventory(strike: number, size: number, vega: number, bucket: string): void {
    const s = Number(size) || 0;
    const v = Number(vega) || 0;

    let bucketInv = this.inventory.get(bucket);
    if (!bucketInv) {
      bucketInv = { vega: 0, count: 0, strikes: [], edgeRequired: 0 };
      this.inventory.set(bucket, bucketInv);
    }

    bucketInv.vega = (Number(bucketInv.vega) || 0) + s * v;
    bucketInv.count = (Number(bucketInv.count) || 0) + 1;

    if (!bucketInv.strikes.includes(strike)) {
      bucketInv.strikes.push(strike);
    }
  }

  /** Calculate smile adjustments from inventory (numeric-safe + coalesced params) */
  calculateSmileAdjustments(): SmileAdjustments {
    let deltaL0 = 0, deltaS0 = 0, deltaC0 = 0, deltaSNeg = 0, deltaSPos = 0;

    for (const [bucket, inv] of this.inventory) {
      const bucketVega = Number(inv.vega) || 0;
      if (Math.abs(bucketVega) < 1e-9) continue;

      const cfg = this.config.buckets.find(b => b.name === bucket);
      if (!cfg) continue;

      const E0    = Number(cfg.edgeParams?.E0)    || 0;
      const kappa = Number(cfg.edgeParams?.kappa) || 0;
      const gamma = Number(cfg.edgeParams?.gamma) || 1;
      const Vref  = Math.max(Number(cfg.edgeParams?.Vref) || 1, 1e-6);

      const normalized = Math.abs(bucketVega) / Vref;
      const edgeRequired = -Math.sign(bucketVega) * (E0 + kappa * Math.pow(normalized, gamma));
      inv.edgeRequired = edgeRequired;

      // scale edge (ticks) to vol changes for visibility
      const TICK_TO_VOL = 0.005;

      switch (bucket) {
        case 'atm':
          deltaL0 += edgeRequired * TICK_TO_VOL * 1.0;
          deltaC0 += Math.sign(bucketVega) * Math.abs(edgeRequired) * 0.0001;
          break;
        case 'rr25':
          if (bucketVega < 0) {
            deltaS0   += Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
            deltaSNeg += -Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
            deltaL0   += Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
          } else {
            deltaS0   -= Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
            deltaSNeg -= -Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
            deltaL0   -= Math.abs(edgeRequired) * TICK_TO_VOL * 0.2;
          }
          break;
        case 'rr10':
          if (bucketVega < 0) {
            deltaSNeg += -Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
            deltaS0   += Math.abs(edgeRequired) * TICK_TO_VOL * 0.15;
          } else {
            deltaSNeg -= -Math.abs(edgeRequired) * TICK_TO_VOL * 0.3;
            deltaS0   -= Math.abs(edgeRequired) * TICK_TO_VOL * 0.15;
          }
          break;
        case 'wings':
          deltaL0   += edgeRequired * TICK_TO_VOL * 0.1;
          deltaSNeg += -edgeRequired * TICK_TO_VOL * 0.4;
          deltaS0   += edgeRequired * TICK_TO_VOL * 0.1;
          break;
      }
    }

    return {
      deltaL0: +deltaL0 || 0,
      deltaS0: +deltaS0 || 0,
      deltaC0: +deltaC0 || 0,
      deltaSNeg: +deltaSNeg || 0,
      deltaSPos: +deltaSPos || 0,
    };
  }

  /** Apply adjustments to create PC from CC (with backoff for validity) */
  adjustSVIForInventory(ccParams: SVIParams): SVIParams {
    const base = SVI.toMetrics(ccParams);
    const adj = this.calculateSmileAdjustments();

    const candidate = (scale: number) => {
      const m: TraderMetrics = {
        L0: Math.max(0.001, base.L0 + adj.deltaL0 * scale),
        S0: base.S0 + adj.deltaS0 * scale,
        C0: Math.max(0.1, base.C0 + adj.deltaC0 * scale),
        S_neg: base.S_neg + adj.deltaSNeg * scale,
        S_pos: base.S_pos + adj.deltaSPos * scale,
      };
      return SVI.fromMetrics(m, this.createSVIConfig());
    };

    let pc = candidate(1.0);
    if (!SVI.validate(pc, this.createSVIConfig())) {
      let s = 0.5;
      while (s > 1e-3) {
        pc = candidate(s);
        if (SVI.validate(pc, this.createSVIConfig())) break;
        s *= 0.5;
      }
      if (!SVI.validate(pc, this.createSVIConfig())) {
        console.warn('Adjusted SVI invalid; using CC.');
        return ccParams;
      }
    }
    return pc;
  }

  createSVIConfig(): any {
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

  getInventoryState(): Map<string, InventoryBucket> {
    return new Map(this.inventory);
  }

  /** Diagnostic summary (numeric-safe) */
  getInventory() {
    const total = { vega: 0, gamma: 0, theta: 0 };
    const byBucket: any = {};

    for (const [bucket, inv] of this.inventory) {
      const v = Number(inv.vega) || 0;
      total.vega += v;
      byBucket[bucket] = { vega: v, count: inv.count };
    }

    return {
      total,
      totalVega: total.vega,
      byBucket,
      smileAdjustments: this.calculateSmileAdjustments()
    };
  }

  clearInventory(): void {
    this.inventory.clear();
  }
}
TS

# Coalesce numbers in IntegratedSmileModel.getInventorySummary()
perl -0777 -i -pe "s/summary\.totalVega \+= inv\.vega;/summary.totalVega += (Number(inv.vega) || 0);/;" apps/server/src/volModels/integratedSmileModel.ts
perl -0777 -i -pe "s/vega: inv\.vega,/vega: (Number(inv.vega) || 0),/;" apps/server/src/volModels/integratedSmileModel.ts

git add apps/server/src/volModels/smileInventoryController.ts apps/server/src/volModels/integratedSmileModel.ts
