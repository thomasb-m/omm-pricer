// apps/server/src/engine/QuoteExplainer.ts
/**
 * Explains every quote decision in human-readable form
 * 
 * Makes the black box transparent:
 * - Why this width?
 * - Why this size?
 * - Why did/didn't we quote?
 */

import { QuoteParams } from '../risk/FactorRisk';
import { FACTOR_LABELS } from '../risk/factors';

export type QuoteDecision = 'quoted' | 'passed';

export type PassReason = 
  | 'edge_too_small'
  | 'size_zero'
  | 'inventory_limit'
  | 'spread_too_wide'
  | 'sigma_not_ready';

export type QuoteExplanation = {
  symbol: string;
  decision: QuoteDecision;
  timestamp: number;
  
  // Basic info (always present)
  theo: number;
  mid: number;
  edge: number;
  
  // If passed, why?
  passReason?: PassReason;
  passDetails?: string;
  
  // If quoted, full breakdown
  breakdown?: {
    // Price components
    inventoryAdjustment: number;  // λ·g (skew)
    theoInv: number;              // theo - skew
    
    // Spread breakdown
    spread: {
      base: number;               // feeBuffer
      model: number;              // z × √(gᵀΣg)
      noise: number;              // η × σ_md
      inventory: number;          // κ × ...
      total: number;
    };
    
    // Size breakdown
    size: {
      rawEdge: number;
      riskPenalty: number;        // gᵀΛg
      ratio: number;              // edge / penalty
      clamped: number;            // After [0, qMax]
      final: number;              // What we actually quote
    };
    
    // Factor contributions (top 3)
    topFactorContributions?: Array<{
      factor: string;
      contribution: number;
      percentage: number;
    }>;
  };
  
  // Human-readable summary
  summary: string;
};

export class QuoteExplainer {
  /**
   * Explain a quote decision
   */
  static explain(
    symbol: string,
    theo: number,
    mid: number,
    quoteParams: QuoteParams,
    minEdge: number,
    features: {
      useModelSpread: boolean;
      useMicrostructure: boolean;
      useInventoryWidening: boolean;
      useInventorySkew: boolean;
    }
  ): QuoteExplanation {
    const edge = Math.abs(theo - mid);
    const hasSize = quoteParams.sizeBid > 0 || quoteParams.sizeAsk > 0;
    
    // Determine decision
    let decision: QuoteDecision = 'passed';
    let passReason: PassReason | undefined;
    let passDetails: string | undefined;
    
    if (edge < minEdge) {
      passReason = 'edge_too_small';
      passDetails = `Edge $${edge.toFixed(2)} < minEdge $${minEdge.toFixed(2)}`;
    } else if (!hasSize) {
      passReason = 'size_zero';
      passDetails = `Size calculation returned 0 (edge/penalty too small)`;
    } else {
      decision = 'quoted';
    }
    
    // Build breakdown if quoted
    const breakdown = decision === 'quoted' ? {
      inventoryAdjustment: quoteParams.skew,
      theoInv: quoteParams.theoInv,
      
      spread: {
        base: quoteParams.spreadComponents.fee,
        model: features.useModelSpread ? quoteParams.spreadComponents.model : 0,
        noise: features.useMicrostructure ? quoteParams.spreadComponents.noise : 0,
        inventory: features.useInventoryWidening ? quoteParams.spreadComponents.inventory : 0,
        total: quoteParams.spreadComponents.total,
      },
      
      size: {
        rawEdge: edge,
        riskPenalty: quoteParams.gLambdaG,
        ratio: quoteParams.gLambdaG > 0 ? edge / quoteParams.gLambdaG : 0,
        clamped: quoteParams.sizeBid,
        final: quoteParams.sizeBid,
      },
      
      topFactorContributions: this.getTopFactors(quoteParams.factorContributions),
    } : undefined;
    
    // Build summary
    const summary = this.buildSummary(decision, passReason, breakdown, features);
    
    return {
      symbol,
      decision,
      timestamp: Date.now(),
      theo,
      mid,
      edge,
      passReason,
      passDetails,
      breakdown,
      summary,
    };
  }
  
  /**
   * Get top 3 factor contributions
   */
  private static getTopFactors(
    contributions?: number[]
  ): Array<{ factor: string; contribution: number; percentage: number }> | undefined {
    if (!contributions || contributions.length === 0) return undefined;
    
    const total = contributions.reduce((sum, c) => sum + Math.abs(c), 0);
    if (total === 0) return undefined;
    
    const withLabels = contributions.map((c, i) => ({
      factor: FACTOR_LABELS[i],
      contribution: c,
      percentage: (Math.abs(c) / total) * 100,
    }));
    
    return withLabels
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 3);
  }
  
  /**
   * Build human-readable summary
   */
  private static buildSummary(
    decision: QuoteDecision,
    passReason?: PassReason,
    breakdown?: any,
    features?: any
  ): string {
    if (decision === 'passed') {
      switch (passReason) {
        case 'edge_too_small':
          return `PASS: Edge too small to profitably quote`;
        case 'size_zero':
          return `PASS: Risk/reward ratio too poor (size = 0)`;
        case 'inventory_limit':
          return `PASS: At inventory limit`;
        default:
          return `PASS: Unknown reason`;
      }
    }
    
    if (!breakdown) return 'QUOTED';
    
    const parts: string[] = ['QUOTED'];
    
    // Inventory adjustment
    if (features?.useInventorySkew && Math.abs(breakdown.inventoryAdjustment) > 0.01) {
      const direction = breakdown.inventoryAdjustment > 0 ? 'up' : 'down';
      parts.push(`inv adj ${direction} $${Math.abs(breakdown.inventoryAdjustment).toFixed(2)}`);
    }
    
    // Spread components
    const spreadParts: string[] = [];
    if (breakdown.spread.base > 0) {
      spreadParts.push(`base $${breakdown.spread.base.toFixed(2)}`);
    }
    if (breakdown.spread.model > 0) {
      spreadParts.push(`model $${breakdown.spread.model.toFixed(2)}`);
    }
    if (breakdown.spread.noise > 0) {
      spreadParts.push(`noise $${breakdown.spread.noise.toFixed(2)}`);
    }
    if (breakdown.spread.inventory > 0) {
      spreadParts.push(`inv $${breakdown.spread.inventory.toFixed(2)}`);
    }
    
    if (spreadParts.length > 0) {
      parts.push(`spread: ${spreadParts.join(' + ')}`);
    }
    
    // Size
    parts.push(`size ${breakdown.size.final.toFixed(1)}`);
    
    // Top factor
    if (breakdown.topFactorContributions && breakdown.topFactorContributions.length > 0) {
      const top = breakdown.topFactorContributions[0];
      parts.push(`(${top.factor}: ${top.percentage.toFixed(0)}%)`);
    }
    
    return parts.join(' | ');
  }
  
  /**
   * Format explanation for console logging
   */
  static formatForConsole(exp: QuoteExplanation, verbose: boolean = false): string {
    const lines: string[] = [];
    
    // Header
    lines.push(`\n${'='.repeat(80)}`);
    lines.push(`📊 ${exp.symbol} | ${exp.decision.toUpperCase()}`);
    lines.push(`${'='.repeat(80)}`);
    
    // Basic info
    lines.push(`Theo: $${exp.theo.toFixed(2)} | Mid: $${exp.mid.toFixed(2)} | Edge: $${exp.edge.toFixed(2)}`);
    
    if (exp.decision === 'passed') {
      lines.push(`\n❌ ${exp.passReason?.toUpperCase().replace(/_/g, ' ')}`);
      if (exp.passDetails) {
        lines.push(`   ${exp.passDetails}`);
      }
    } else if (exp.breakdown) {
      const b = exp.breakdown;
      
      // Inventory adjustment
      if (Math.abs(b.inventoryAdjustment) > 0.001) {
        lines.push(`\n📦 Inventory Adjustment: $${b.inventoryAdjustment.toFixed(2)}`);
        lines.push(`   Adjusted Theo: $${b.theoInv.toFixed(2)}`);
      }
      
      // Spread breakdown
      lines.push(`\n📏 Spread Breakdown (total: $${b.spread.total.toFixed(2)}):`);
      lines.push(`   Base (fee):      $${b.spread.base.toFixed(2)}`);
      if (b.spread.model > 0) {
        const modelStr = b.spread.model < 0.01 ? b.spread.model.toFixed(4) : b.spread.model.toFixed(2);
        lines.push(`   Model:           $${modelStr}`);
      }
      if (b.spread.noise > 0) {
        const noiseStr = b.spread.noise < 0.01 ? b.spread.noise.toFixed(4) : b.spread.noise.toFixed(2);
        lines.push(`   Microstructure:  $${noiseStr}`);
      }
      if (b.spread.inventory > 0) {
        const invStr = b.spread.inventory < 0.01 ? b.spread.inventory.toFixed(4) : b.spread.inventory.toFixed(2);
        lines.push(`   Inventory:       $${invStr}`);
      }
      
      // Size breakdown
      lines.push(`\n📊 Size Calculation:`);
      lines.push(`   Raw Edge:        $${b.size.rawEdge.toFixed(2)}`);
      lines.push(`   Risk Penalty:    ${b.size.riskPenalty.toFixed(6)} (g^T Λ g)`);
      lines.push(`   Ratio:           ${b.size.ratio.toFixed(4)}`);
      lines.push(`   Final Size:      ${b.size.final.toFixed(1)} contracts`);
      
      // Factor contributions (verbose mode)
      if (verbose && b.topFactorContributions) {
        lines.push(`\n🔍 Top Risk Factors:`);
        for (const fc of b.topFactorContributions) {
          lines.push(`   ${fc.factor.padEnd(8)} ${fc.percentage.toFixed(1)}%  ($${fc.contribution.toFixed(4)})`);
        }
      }
    }
    
    // Summary
    lines.push(`\n💡 ${exp.summary}`);
    lines.push(`${'='.repeat(80)}\n`);
    
    return lines.join('\n');
  }
}