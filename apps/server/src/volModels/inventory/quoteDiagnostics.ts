/**
 * Types and utilities for quote diagnostics
 * Enables parallel testing (old vs new) and comprehensive logging
 */

import type { VarianceBumpResult } from './varianceBump';

export interface QuoteDiagnostics {
  // Instrument
  expiryMs: number;
  strike: number;
  forward: number;
  optionType: 'C' | 'P';
  
  // Timing
  T: number;           // Time to expiry (years)
  k: number;           // Log-moneyness
  nowMs: number;       // Quote timestamp
  
  // CC state
  ivCC: number;
  wCC: number;
  ccMid: number;
  
  // PC state (new method)
  ivPC: number;
  pcMid: number;
  edge: number;
  
  // Inventory
  lambda: number[];
  inventory: number[];
  
  // Variance bump details
  varianceBump: VarianceBumpResult['diagnostics'];
  
  // Warnings/flags
  warnings?: string[];
  
  // Legacy comparison (if running in parallel mode)
  legacy?: {
    pcMid: number;
    edge: number;
    method: string;
  };
}

export interface ParallelModeConfig {
  enabled: boolean;
  sampleRate: number;  // 0-1, fraction of quotes to compare
  logDifferences: boolean;
  alertThreshold: number;  // Difference % to trigger alert
}

export class QuoteDiagnosticsLogger {
  private config: ParallelModeConfig;
  private buffer: QuoteDiagnostics[] = [];
  private maxBufferSize: number = 1000;
  
  constructor(config: Partial<ParallelModeConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? false,
      sampleRate: config.sampleRate ?? 0.1,  // 10% sampling by default
      logDifferences: config.logDifferences ?? true,
      alertThreshold: config.alertThreshold ?? 0.05  // 5% difference
    };
  }

  /**
   * Log a quote with full diagnostics
   */
  log(diag: QuoteDiagnostics): void {
    // Sampling: only log a fraction of quotes to avoid spam
    if (Math.random() > this.config.sampleRate) {
      return;
    }

    this.buffer.push(diag);
    
    // Trim buffer if too large
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }

    // Console log in development
    if (process.env.NODE_ENV === 'development') {
      this.logToConsole(diag);
    }

    // Check for alerts (parallel mode comparisons)
    if (this.config.enabled && this.config.logDifferences && diag.legacy) {
      this.checkDifference(diag);
    }
  }

  /**
   * Compare new vs legacy method
   */
  private checkDifference(diag: QuoteDiagnostics): void {
    if (!diag.legacy) return;

    const newMid = diag.pcMid;
    const oldMid = diag.legacy.pcMid;
    const diffPct = Math.abs(newMid - oldMid) / Math.max(oldMid, 1e-8);

    if (diffPct > this.config.alertThreshold) {
      console.warn('[QuoteDiff] Large difference detected:', {
        strike: diag.strike,
        expiry: new Date(diag.expiryMs).toISOString(),
        newMid: newMid.toFixed(6),
        oldMid: oldMid.toFixed(6),
        diffPct: (diffPct * 100).toFixed(2) + '%',
        warnings: diag.warnings
      });
    }
  }

  /**
   * Format for console output
   */
  private logToConsole(diag: QuoteDiagnostics): void {
    const compact = {
      K: diag.strike,
      T: diag.T.toFixed(4),
      ivCC: diag.ivCC.toFixed(3),
      ivPC: diag.ivPC.toFixed(3),
      edge: diag.edge.toFixed(4),
      deltaW: diag.varianceBump.deltaW.toFixed(6),
      clipped: diag.varianceBump.clipped,
      warnings: diag.warnings?.length ?? 0
    };

    if (diag.legacy) {
      Object.assign(compact, {
        oldMid: diag.legacy.pcMid.toFixed(4),
        newMid: diag.pcMid.toFixed(4),
        diff: (diag.pcMid - diag.legacy.pcMid).toFixed(4)
      });
    }

    console.debug('[QuoteDiag]', JSON.stringify(compact));
  }

  /**
   * Get statistics on recent quotes
   */
  getStats(): {
    count: number;
    avgEdge: number;
    avgIVChange: number;
    clippedPct: number;
    boundedPct: number;
    avgDiff?: number;  // If parallel mode
  } {
    if (this.buffer.length === 0) {
      return {
        count: 0,
        avgEdge: 0,
        avgIVChange: 0,
        clippedPct: 0,
        boundedPct: 0
      };
    }

    const n = this.buffer.length;
    let sumEdge = 0;
    let sumIVChange = 0;
    let clippedCount = 0;
    let boundedCount = 0;
    let sumDiff = 0;
    let diffCount = 0;

    for (const d of this.buffer) {
      sumEdge += Math.abs(d.edge);
      sumIVChange += Math.abs(d.ivPC - d.ivCC);
      
      if (d.varianceBump.clipped) clippedCount++;
      if (d.varianceBump.bounded) boundedCount++;
      
      if (d.legacy) {
        sumDiff += Math.abs(d.pcMid - d.legacy.pcMid);
        diffCount++;
      }
    }

    return {
      count: n,
      avgEdge: sumEdge / n,
      avgIVChange: sumIVChange / n,
      clippedPct: (clippedCount / n) * 100,
      boundedPct: (boundedCount / n) * 100,
      avgDiff: diffCount > 0 ? sumDiff / diffCount : undefined
    };
  }

  /**
   * Export recent quotes for analysis
   */
  exportBuffer(): QuoteDiagnostics[] {
    return [...this.buffer];
  }

  /**
   * Clear buffer
   */
  clear(): void {
    this.buffer = [];
  }
}

/**
 * Singleton instance for app-wide logging
 */
export const quoteDiagLogger = new QuoteDiagnosticsLogger({
  enabled: process.env.QUOTE_DIAG_ENABLED === 'true',
  sampleRate: parseFloat(process.env.QUOTE_DIAG_SAMPLE_RATE ?? '0.1'),
  logDifferences: process.env.QUOTE_DIAG_LOG_DIFFS !== 'false',
  alertThreshold: parseFloat(process.env.QUOTE_DIAG_ALERT_THRESHOLD ?? '0.05')
});