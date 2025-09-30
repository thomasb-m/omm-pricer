/**
 * Integrated Dual Surface Model
 * Combines CC (belief), PC (price curve with inventory bumps), and width-delta rule
 */

import { 
    SVIParams, 
    TraderMetrics, 
    NodeState, 
    Surface, 
    SVI,
    BumpFunctions,
    WidthDelta
  } from './dualSurfaceModel';
  import { ModelConfig, getDefaultConfig } from './config/modelConfig';
  import { InventoryController } from './controllers/inventoryController';
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
  
  export class IntegratedDualSurface {
    private surfaces: Map<number, Surface>;
    private inventoryController: InventoryController;
    private riskScorer: RiskScorer;
    private config: ModelConfig;
    private sviConfig: any; // Config format for SVI functions
    private version: number;
    
    constructor(product: 'BTC' | 'ETH' | 'SPX' = 'BTC') {
      this.config = getDefaultConfig(product);
      // Convert ModelConfig to Config format for SVI
      this.sviConfig = this.convertToSVIConfig(this.config);
      this.surfaces = new Map();
      this.inventoryController = new InventoryController(this.config);
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
        // Initialize new surface
        surface = {
          expiry,
          cc: newCC,
          pcBumps: [],
          nodes: new Map()
        };
        this.surfaces.set(expiry, surface);
      } else {
        // Rebase PC bumps to maintain edge with new CC
        const spot = 100; // Should be passed in
        surface.pcBumps = this.inventoryController.rebaseBumps(
          surface.cc,
          newCC,
          surface.pcBumps,
          expiry,
          spot
        );
        surface.cc = newCC;
      }
      
      this.version++;
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
      
      // 4. Check if bumps need updating
      if (this.inventoryController.needsBumpUpdate(bucket)) {
        this.updatePCBumps(surface, trade.expiry, trade.spot);
      }
      
      this.version++;
    }
    
    /**
     * Update node state after trade
     */
    private updateNodeState(surface: Surface, trade: TradeExecution): void {
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
     * Update PC bumps based on inventory
     */
    private updatePCBumps(surface: Surface, expiry: number, spot: number): void {
      // Only generate bumps for strikes where we have positions
      const newBumps = [];
      
      // Get inventory state
      const invState = this.inventoryController.getInventoryState();
      
      // For each bucket with inventory
      for (const [bucket, bucketInv] of invState.byBucket) {
        if (Math.abs(bucketInv.signedVega) < 0.1) continue;  // Skip if no significant inventory
        
        // Get strikes where we actually have positions in this bucket
        const strikesWithPositions: number[] = [];
        
        for (const [strike, node] of surface.nodes) {
          if (node.position !== 0) {
            // Check if this strike is in the current bucket
            const k = Math.log(strike / spot);
            const variance = SVI.w(surface.cc, k);
            const iv = Math.sqrt(variance / expiry);
            const strikeBucket = DeltaConventions.strikeToBucket(strike, spot, iv, expiry);
            
            if (strikeBucket === bucket) {
              strikesWithPositions.push(strike);
            }
          }
        }
        
        // Only generate bumps if we have positions in this bucket
        if (strikesWithPositions.length > 0) {
          const bumps = this.inventoryController.generateBumps(
            bucket,
            surface.cc,
            expiry,
            spot,
            strikesWithPositions
          );
          newBumps.push(...bumps);
        }
      }
      
      // Replace old bumps
      surface.pcBumps = newBumps;
    }
    
    /**
     * Get representative strikes for each bucket
     */
    private getBucketStrikes(spot: number, expiry: number): Map<string, number[]> {
      const bucketStrikes = new Map<string, number[]>();
      
      // ATM strikes
      bucketStrikes.set('atm', [
        spot * 0.98,
        spot * 0.99,
        spot * 1.00,
        spot * 1.01,
        spot * 1.02
      ]);
      
      // 25-delta strikes (approximate)
      bucketStrikes.set('rr25', [
        spot * 0.93,
        spot * 0.94,
        spot * 0.95,
        spot * 1.05,
        spot * 1.06,
        spot * 1.07
      ]);
      
      // 10-delta strikes
      bucketStrikes.set('rr10', [
        spot * 0.88,
        spot * 0.90,
        spot * 1.10,
        spot * 1.12
      ]);
      
      // Wing strikes
      bucketStrikes.set('wings', [
        spot * 0.80,
        spot * 0.85,
        spot * 1.15,
        spot * 1.20
      ]);
      
      return bucketStrikes;
    }
    
    /**
     * Get quotes with full integration
     */
    getQuote(expiry: number, strike: number, spot: number): Quote {
      const surface = this.surfaces.get(expiry);
      if (!surface) {
        throw new Error(`No surface for expiry ${expiry}`);
      }
      
      const k = Math.log(strike / spot);
      
      // 1. Calculate CC price
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
      
      // 2. Calculate PC price (CC + bumps)
      const bumpAdjustment = BumpFunctions.evalBumps(surface.pcBumps, k);
      const pcVariance = ccVariance + bumpAdjustment;
      const pcIV = Math.sqrt(Math.max(pcVariance, 1e-8) / expiry);
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
        gamma: ccGreeks.gamma,
        J_L0: 1.0,  // Placeholder sensitivities
        J_S0: 0.5,
        J_C0: 0.3
      });
      
      const pcMid = WidthDelta.getPCMid(
        node,
        currentWidth,
        ccMid,
        this.config.quotes.staleHours
      );
      
      // 5. Build quote
      const bid = pcMid - currentWidth;
      const ask = pcMid + currentWidth;
      
      // 6. Calculate edge (PC - CC)
      const edge = pcMid - ccMid;
      
      // 7. Size based on inventory
      const baseSize = this.config.quotes.sizeBlocks;
      const invState = this.inventoryController.getInventoryState();
      const bucketInv = invState.byBucket.get(bucket);
      
      let bidSize = baseSize;
      let askSize = baseSize;
      
      if (bucketInv) {
        const invRatio = Math.abs(bucketInv.signedVega) / 
          this.config.buckets.find(b => b.name === bucket)!.edgeParams.Vref;
        
        if (bucketInv.signedVega < 0) {
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
     * Get inventory summary
     */
    getInventorySummary() {
      const state = this.inventoryController.getInventoryState();
      const summary = {
        totalVega: state.totalVega,
        byBucket: {} as any,
        edges: {} as any
      };
      
      for (const [bucket, inv] of state.byBucket) {
        summary.byBucket[bucket] = {
          vega: inv.signedVega,
          count: inv.count
        };
        summary.edges[bucket] = this.inventoryController.getCurrentEdge(bucket);
      }
      
      return summary;
    }
    
    /**
     * Update market observations for risk scorer
     */
    updateMarketObservations(observations: any[]): void {
      this.riskScorer.updateFromMarket(observations);
    }
  }
  
  /**
   * Test the integrated model
   */
  export function testIntegratedModel(): void {
    console.log('\n' + '='.repeat(60));
    console.log('INTEGRATED DUAL SURFACE MODEL TEST');
    console.log('='.repeat(60) + '\n');
    
    const model = new IntegratedDualSurface('BTC');
    
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
    
    // Get initial quotes
    const strikes = [90, 95, 100, 105, 110];
    
    console.log('Initial quotes (no position):');
    console.log('Strike | Bucket | Bid    | Ask    | PC Mid | CC Mid | Edge');
    console.log('-'.repeat(65));
    
    for (const strike of strikes) {
      const quote = model.getQuote(expiry, strike, spot);
      console.log(
        `${strike.toString().padStart(6)} | ` +
        `${quote.bucket.padEnd(6)} | ` +
        `${quote.bid.toFixed(2).padStart(6)} | ` +
        `${quote.ask.toFixed(2).padStart(6)} | ` +
        `${quote.pcMid.toFixed(2).padStart(6)} | ` +
        `${quote.ccMid.toFixed(2).padStart(6)} | ` +
        `${quote.edge.toFixed(2).padStart(5)}`
      );
    }
    
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
    
    // Get post-trade quotes
    console.log('Post-trade quotes:');
    console.log('Strike | Bucket | Bid    | Ask    | PC Mid | CC Mid | Edge  | Sizes');
    console.log('-'.repeat(75));
    
    for (const strike of strikes) {
      const quote = model.getQuote(expiry, strike, spot);
      const marker = strike === 95 ? ' ←' : '  ';
      console.log(
        `${strike.toString().padStart(6)} | ` +
        `${quote.bucket.padEnd(6)} | ` +
        `${quote.bid.toFixed(2).padStart(6)} | ` +
        `${quote.ask.toFixed(2).padStart(6)} | ` +
        `${quote.pcMid.toFixed(2).padStart(6)} | ` +
        `${quote.ccMid.toFixed(2).padStart(6)} | ` +
        `${quote.edge.toFixed(2).padStart(5)} | ` +
        `${quote.bidSize}/${quote.askSize}${marker}`
      );
    }
    
    // Show inventory
    console.log('\n' + '-'.repeat(60));
    console.log('\n📊 Inventory Summary:\n');
    
    const inventory = model.getInventorySummary();
    console.log(`Total Vega: ${inventory.totalVega.toFixed(1)}`);
    console.log('\nBy Bucket:');
    for (const [bucket, data] of Object.entries(inventory.byBucket)) {
      const bucketData = data as { vega: number; count: number };
      const edge = (inventory.edges as any)[bucket];
      console.log(`  ${bucket}: ${bucketData.vega.toFixed(1)} vega, edge = ${edge.toFixed(2)} ticks`);
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ INTEGRATED MODEL TEST COMPLETE');
    console.log('='.repeat(60) + '\n');
  }
  
  // Run if executed directly
  if (require.main === module) {
    testIntegratedModel();
  }