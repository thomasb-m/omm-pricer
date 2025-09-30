/**
 * Integrated Dual Surface Model with Smile-Based Adjustments
 * PC adjusts entire smile shape based on inventory, not local bumps
 */

import { 
  SVIParams, 
  TraderMetrics, 
  NodeState, 
  Surface, 
  SVI,
  WidthDelta
} from './dualSurfaceModel';
import { ModelConfig, getDefaultConfig } from './config/modelConfig';
import { SmileInventoryController } from './smileInventoryController';
import { RiskScorer } from './dualSurfaceModel';
import { blackScholes, DeltaConventions } from './pricing/blackScholes';

export interface Quote {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  pcMid: number;
  ccMid: number;
  edge: number;
  bucket: string;
}

export interface TradeExecution {
  expiry: number;
  strike: number;
  price: number;
  size: number;    // Negative = sold
  spot: number;
  time: number;
}

export interface EnhancedSurface {
  expiry: number;
  cc: SVIParams;           // Core Curve (belief)
  pc: SVIParams;           // Price Curve (with inventory adjustments)
  nodes: Map<number, NodeState>;  // Strike -> NodeState
}

export class IntegratedSmileModel {
  private surfaces: Map<number, EnhancedSurface>;
  private inventoryController: SmileInventoryController;
  private riskScorer: RiskScorer;
  private config: ModelConfig;
  private sviConfig: any;
  private version: number;
  
  constructor(product: 'BTC' | 'ETH' | 'SPX' = 'BTC') {
    this.config = getDefaultConfig(product);
    this.sviConfig = this.convertToSVIConfig(this.config);
    this.surfaces = new Map();
    this.inventoryController = new SmileInventoryController(this.config);
    this.riskScorer = new RiskScorer();
    this.version = 0;
  }
  
  private convertToSVIConfig(mc: ModelConfig): any {
    const edgeParams = new Map();
    mc.buckets.forEach(bucket => {
      edgeParams.set(bucket.name, bucket.edgeParams);
    });
    
    return {
      bMin: mc.svi.bMin,
      sigmaMin: mc.svi.sigmaMin,
      rhoMax: mc.svi.rhoMax,
      sMax: mc.svi.slopeMax,
      c0Min: mc.svi.c0Min,
      buckets: mc.buckets.map(b => ({
        name: b.name,
        minDelta: b.minDelta,
        maxDelta: b.maxDelta
      })),
      edgeParams,
      rbfWidth: mc.rbf.width,
      ridgeLambda: mc.rbf.ridgeLambda,
      maxL0Move: mc.riskLimits.maxL0Move,
      maxS0Move: mc.riskLimits.maxS0Move,
      maxC0Move: mc.riskLimits.maxC0Move
    };
  }
  
  /**
   * Initialize or update Core Curve (CC)
   */
  updateCC(expiry: number, metrics: TraderMetrics): void {
    const newCC = SVI.fromMetrics(metrics, this.sviConfig);
    
    if (!SVI.validate(newCC, this.sviConfig)) {
      throw new Error('Invalid SVI parameters');
    }
    
    let surface = this.surfaces.get(expiry);
    
    if (!surface) {
      // Initialize new surface with CC = PC initially
      surface = {
        expiry,
        cc: newCC,
        pc: newCC,  // Initially PC = CC
        nodes: new Map()
      };
      this.surfaces.set(expiry, surface);
    } else {
      // Update CC and regenerate PC based on inventory
      surface.cc = newCC;
      this.updatePC(surface);
    }
    
    this.version++;
  }
  
  /**
   * Update PC based on current inventory
   */
  private updatePC(surface: EnhancedSurface): void {
    // Get adjusted SVI parameters based on inventory
    surface.pc = this.inventoryController.adjustSVIForInventory(surface.cc);
  }
  
  /**
   * Execute a trade and update everything
   */
  onTrade(trade: TradeExecution): void {
    const surface = this.surfaces.get(trade.expiry);
    if (!surface) {
      console.warn(`No surface for expiry ${trade.expiry}`);
      return;
    }
    
    // 1. Update node state (PC anchor)
    this.updateNodeState(surface, trade);
    
    // 2. Calculate Greeks for inventory tracking
    const k = Math.log(trade.strike / trade.spot);
    const variance = SVI.w(surface.cc, k);
    const iv = Math.sqrt(variance / trade.expiry);
    
    const greeks = blackScholes({
      strike: trade.strike,
      spot: trade.spot,
      vol: iv,
      T: trade.expiry,
      r: 0,
      isCall: false
    });
    
    // 3. Update inventory
    const bucket = DeltaConventions.strikeToBucket(
      trade.strike,
      trade.spot,
      iv,
      trade.expiry
    );
    
    this.inventoryController.updateInventory(
      trade.strike,
      trade.size,
      greeks.vega,
      bucket
    );
    
    // 4. Update PC based on new inventory
    this.updatePC(surface);
    
    this.version++;
  }
  
  /**
   * Update node state after trade
   */
  private updateNodeState(surface: EnhancedSurface, trade: TradeExecution): void {
    let node = surface.nodes.get(trade.strike);
    
    if (!node) {
      // Create new node
      const bucket = DeltaConventions.strikeToBucket(
        trade.strike,
        trade.spot,
        0.3, // Approximate IV
        surface.expiry
      );
      
      node = {
        strike: trade.strike,
        pcAnchor: trade.price,
        widthRef: this.riskScorer.computeWidth({ gamma: 0.1 }),
        position: trade.size,
        lastBucket: bucket,
        lastTradeTime: Date.now()
      };
      surface.nodes.set(trade.strike, node);
    } else {
      // Update existing node
      node.pcAnchor = trade.price;
      node.position += trade.size;
      node.lastTradeTime = Date.now();
      node.widthRef = this.riskScorer.computeWidth({ gamma: 0.1 });
    }
  }
  
  /**
   * Get quotes with smile-adjusted PC
   */
  getQuote(expiry: number, strike: number, spot: number): Quote {
    const surface = this.surfaces.get(expiry);
    if (!surface) {
      throw new Error(`No surface for expiry ${expiry}`);
    }
    
    const k = Math.log(strike / spot);
    
    // 1. Calculate CC price (belief)
    const ccVariance = SVI.w(surface.cc, k);
    const ccIV = Math.sqrt(ccVariance / expiry);
    const ccGreeks = blackScholes({
      strike,
      spot,
      vol: ccIV,
      T: expiry,
      r: 0,
      isCall: false
    });
    const ccMid = ccGreeks.price;
    
    // 2. Calculate PC price (adjusted for inventory)
    const pcVariance = SVI.w(surface.pc, k);
    const pcIV = Math.sqrt(pcVariance / expiry);
    const pcGreeks = blackScholes({
      strike,
      spot,
      vol: pcIV,
      T: expiry,
      r: 0,
      isCall: false
    });
    
    // 3. Get or create node state
    let node = surface.nodes.get(strike);
    const bucket = DeltaConventions.strikeToBucket(strike, spot, ccIV, expiry);
    
    if (!node) {
      node = {
        strike,
        pcAnchor: pcGreeks.price,
        widthRef: this.riskScorer.computeWidth({ gamma: ccGreeks.gamma }),
        position: 0,
        lastBucket: bucket,
        lastTradeTime: Date.now()
      };
    }
    
    // 4. Apply width-delta rule
    const currentWidth = this.riskScorer.computeWidth({ 
      gamma: pcGreeks.gamma,
      J_L0: 1.0,
      J_S0: 0.5,
      J_C0: 0.3
    });
    
    const pcMid = pcGreeks.price;
    
    // 5. Build quote
    const bid = pcMid - currentWidth;
    const ask = pcMid + currentWidth;
    
    // 6. Calculate edge (PC - CC)
    const edge = pcMid - ccMid;
    
    // 7. Size based on inventory
    const baseSize = this.config.quotes.sizeBlocks;
    const invState = this.inventoryController.getInventoryState();
    const bucketInv = invState.get(bucket);
    
    let bidSize = baseSize;
    let askSize = baseSize;
    
    if (bucketInv) {
      const invRatio = Math.abs(bucketInv.vega) / 
        this.config.buckets.find(b => b.name === bucket)!.edgeParams.Vref;
      
      if (bucketInv.vega < 0) {
        // Short - reduce ask size
        askSize = Math.max(10, baseSize * Math.exp(-invRatio));
      } else {
        // Long - reduce bid size
        bidSize = Math.max(10, baseSize * Math.exp(-invRatio));
      }
    }
    
    return {
      bid,
      ask,
      bidSize: Math.round(bidSize),
      askSize: Math.round(askSize),
      pcMid,
      ccMid,
      edge,
      bucket
    };
  }
  
  /**
   * Get inventory summary with smile adjustments
   */
  getInventorySummary() {
    const invState = this.inventoryController.getInventoryState();
    const adjustments = this.inventoryController.calculateSmileAdjustments();
    
    const summary = {
      totalVega: 0,
      byBucket: {} as any,
      smileAdjustments: adjustments
    };
    
    for (const [bucket, inv] of invState) {
      summary.totalVega += inv.vega;
      summary.byBucket[bucket] = {
        vega: inv.vega,
        count: inv.count
      };
    }
    
    return summary;
  }
  
  /**
   * Update market observations for risk scorer
   */
  updateMarketObservations(observations: any[]): void {
    this.riskScorer.updateFromMarket(observations);
  }
  
  /**
   * Compare CC and PC surfaces
   */
  compareSurfaces(expiry: number, spot: number): void {
    const surface = this.surfaces.get(expiry);
    if (!surface) return;
    
    console.log('\nSurface Comparison (CC vs PC):');
    console.log('Strike | CC Vol  | PC Vol  | Edge   | Bucket');
    console.log('-'.repeat(50));
    
    const strikes = [
      spot * 0.80,
      spot * 0.90,
      spot * 0.95,
      spot * 1.00,
      spot * 1.05,
      spot * 1.10,
      spot * 1.20
    ];
    
    for (const strike of strikes) {
      const k = Math.log(strike / spot);
      
      const ccVar = SVI.w(surface.cc, k);
      const pcVar = SVI.w(surface.pc, k);
      
      const ccVol = Math.sqrt(ccVar / expiry) * 100;
      const pcVol = Math.sqrt(pcVar / expiry) * 100;
      
      const ccPrice = blackScholes({
        strike,
        spot,
        vol: ccVol / 100,
        T: expiry,
        r: 0,
        isCall: false
      }).price;
      
      const pcPrice = blackScholes({
        strike,
        spot,
        vol: pcVol / 100,
        T: expiry,
        r: 0,
        isCall: false
      }).price;
      
      const edge = pcPrice - ccPrice;
      const bucket = DeltaConventions.strikeToBucket(strike, spot, ccVol / 100, expiry);
      
      console.log(
        `${strike.toFixed(0).padStart(6)} | ` +
        `${ccVol.toFixed(2).padStart(7)}% | ` +
        `${pcVol.toFixed(2).padStart(7)}% | ` +
        `${edge.toFixed(2).padStart(6)} | ` +
        `${bucket}`
      );
    }
  }
}

/**
 * Test the integrated model with smile adjustments
 */
export function testIntegratedSmileModel(): void {
  console.log('\n' + '='.repeat(60));
  console.log('INTEGRATED MODEL WITH SMILE ADJUSTMENTS');
  console.log('='.repeat(60) + '\n');
  
  const model = new IntegratedSmileModel('BTC');
  
  // Setup CC
  const expiry = 0.25; // 3 months
  const spot = 100;
  
  const initialMetrics: TraderMetrics = {
    L0: 0.04,    // 20% vol
    S0: 0.001,
    C0: 0.5,
    S_neg: -0.8,
    S_pos: 0.9
  };
  
  model.updateCC(expiry, initialMetrics);
  console.log('✅ Initialized CC with 20% ATM vol\n');
  
  // Show initial state
  console.log('Initial state (no inventory):');
  model.compareSurfaces(expiry, spot);
  
  // Execute a trade
  console.log('\n' + '-'.repeat(60));
  console.log('\n📝 TRADE: Sell 100 lots of 95 strike put\n');
  
  const trade: TradeExecution = {
    expiry,
    strike: 95,
    price: 3.50,
    size: -100,  // Negative = sold
    spot,
    time: Date.now()
  };
  
  model.onTrade(trade);
  
  // Show post-trade state
  console.log('After trade (short 25d puts):');
  model.compareSurfaces(expiry, spot);
  
  // Get specific quotes
  console.log('\n' + '-'.repeat(60));
  console.log('\nDetailed quotes:');
  console.log('Strike | Bid    | Ask    | Size   | Edge');
  console.log('-'.repeat(45));
  
  const strikes = [90, 95, 100, 105, 110];
  for (const strike of strikes) {
    const quote = model.getQuote(expiry, strike, spot);
    const marker = strike === 95 ? ' ← traded' : '';
    console.log(
      `${strike.toString().padStart(6)} | ` +
      `${quote.bid.toFixed(2).padStart(6)} | ` +
      `${quote.ask.toFixed(2).padStart(6)} | ` +
      `${quote.bidSize}/${quote.askSize.toString().padEnd(3)} | ` +
      `${quote.edge.toFixed(2).padStart(5)}${marker}`
    );
  }
  
  // Show inventory and adjustments
  console.log('\n' + '-'.repeat(60));
  console.log('\n📊 Inventory & Smile Adjustments:\n');
  
  const summary = model.getInventorySummary();
  console.log(`Total Vega: ${summary.totalVega.toFixed(1)}\n`);
  
  console.log('Smile parameter adjustments:');
  const adj = summary.smileAdjustments;
  console.log(`  ΔL0 (level):  ${(adj.deltaL0 * 100).toFixed(3)}% vol`);
  console.log(`  ΔS0 (skew):   ${(adj.deltaS0 * 100).toFixed(3)}% vol/unit`);
  console.log(`  ΔC0 (curve):  ${adj.deltaC0.toFixed(4)}`);
  console.log(`  ΔS_neg (left): ${(adj.deltaSNeg * 100).toFixed(3)}% vol/unit`);
  console.log(`  ΔS_pos (right): ${(adj.deltaSPos * 100).toFixed(3)}% vol/unit`);
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ SMILE-BASED MODEL COMPLETE');
  console.log('='.repeat(60) + '\n');
}

// Run if executed directly
if (require.main === module) {
  testIntegratedSmileModel();
}