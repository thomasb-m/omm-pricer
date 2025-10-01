/**
 * Integrated Dual Surface Model with Market Calibration
 * Auto-calibrates from actual market IVs instead of hardcoded defaults
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
  import { black76Greeks } from "../risk"; // or wherever you placed black76Greeks
  import { timeToExpiryYears } from "../utils/time"; // helper that returns T in years
  
  const tiny = 1e-12;
  const safe = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback);

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
    expiryMs: number;          // absolute expiry timestamp (ms)
    strike: number;
    forward: number;           // use the perp/forward, not spot
    optionType: 'C' | 'P';     // call or put
    price: number;
    size: number;              // signed from CUSTOMER perspective; you can keep same convention you used before
    time: number;              // trade timestamp (ms)
  }
  
  
  export interface EnhancedSurface {
    expiry: number;
    cc: SVIParams;
    pc: SVIParams;
    nodes: Map<number, NodeState>;
  }
  
  export interface MarketQuoteForCalibration {
    strike: number;
    iv: number;
    weight?: number;
  }
  
  export class IntegratedSmileModel {
    private surfaces: Map<number, EnhancedSurface>;
    private inventoryController: SmileInventoryController;
    private riskScorer: RiskScorer;
    private config: ModelConfig;
    private sviConfig: any;
    private version: number;
    private marketIVs: Map<number, number>;
    
    constructor(product: 'BTC' | 'ETH' | 'SPX' = 'BTC') {
      this.config = getDefaultConfig(product);
      this.sviConfig = this.convertToSVIConfig(this.config);
      this.surfaces = new Map();
      this.inventoryController = new SmileInventoryController(this.config);
      this.riskScorer = new RiskScorer();
      this.version = 0;
      this.marketIVs = new Map();
    }
    
    private deriveMetricsFromMarketIV(atmIV: number, expiry: number): TraderMetrics {
      const L0 = atmIV * atmIV * expiry;
      
      return {
        L0: L0,
        S0: -0.02,
        C0: 0.5,
        S_neg: -0.8,
        S_pos: 0.9
      };
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
    
    updateCC(expiry: number, metrics: TraderMetrics): void {
      const newCC = SVI.fromMetrics(metrics, this.sviConfig);
      
      if (!SVI.validate(newCC, this.sviConfig)) {
        throw new Error('Invalid SVI parameters');
      }
      
      let surface = this.surfaces.get(expiry);
      
      if (!surface) {
        surface = {
          expiry,
          cc: newCC,
          pc: newCC,
          nodes: new Map()
        };
        this.surfaces.set(expiry, surface);
      } else {
        surface.cc = newCC;
        this.updatePC(surface);
      }
      
      this.version++;
    }
    
    private updatePC(surface: EnhancedSurface): void {
      surface.pc = this.inventoryController.adjustSVIForInventory(surface.cc);
    }
    
    onTrade(trade: TradeExecution): void {
        // Get/validate surface for this expiry
        const surface = this.surfaces.get(trade.expiryMs);
        if (!surface) {
          console.warn(`No surface for expiryMs=${trade.expiryMs}`);
          return;
        }
      
        // Convert expiry to years
        const T = timeToExpiryYears(trade.expiryMs, trade.time ?? Date.now());
        if (T <= 0) {
          console.warn(`Expired trade ignored (T<=0):`, trade);
          return;
        }
      
        const isCall = trade.optionType === 'C';
        const F = trade.forward;
        const K = trade.strike;
      
        // Update node state (anchor, width reference, position)
        this.updateNodeState(surface, {
          strike: K,
          price: trade.price,
          size: trade.size,
          expiryMs: trade.expiryMs,
          forward: F,
          optionType: trade.optionType,
          time: trade.time ?? Date.now(),
        } as any); // see helper signature note below
      
        // Forward moneyness for SVI
        const k = Math.log(K / F);
      
        // Use CC for greeks/bucketing (fair curve)
        const ccVar = SVI.w(surface.cc, k);
        const ccIV  = Math.sqrt(ccVar / T);
      
        // Black-76 greeks (absolute vol conventions)
        console.debug("[b76 trade] args", { F, K, T, sigma: ccIV, isCall });
        const greeks = black76Greeks(F, K, T, ccIV, isCall, /*df*/ 1.0);
      
        // Put-delta convention for bucket mapping
        console.debug("[b76 trade] args", { F, K, T, sigma: ccIV, isCall });
        const putGreeks = black76Greeks(F, K, T, ccIV, /*isCall*/ false, 1.0);
        const putDeltaAbs = Math.abs(putGreeks.delta);
      
        // If you have a dedicated forward-delta bucketer, use it; otherwise reuse your DeltaConventions
        const bucket = DeltaConventions.strikeToBucket(
          /*strike*/ K,
          /*spotOrF*/ F,
          /*iv*/ ccIV,
          /*T*/ T,
          /*r?*/ 0
        );
      
        // Update inventory with vega (per absolute vol unit)
        this.inventoryController.updateInventory(
          K,
          trade.size,
          greeks.vega,
          bucket
        );
      
        // Recompute PC from inventory-aware adjustments
        this.updatePC(surface);
      
        this.version++;
      }
      
    
      private updateNodeState(
        surface: EnhancedSurface,
        trade: {
          strike: number;
          price: number;
          size: number;
          expiryMs: number;
          forward: number;
          optionType: 'C'|'P';
          time: number;
        }
      ): void {
        let node = surface.nodes.get(trade.strike);
      
        // Compute a width ref using a simple gamma proxy (you can refine)
        const T = timeToExpiryYears(trade.expiryMs, trade.time);
        const k = Math.log(trade.strike / trade.forward);
        const ccVar = SVI.w(surface.cc, k);
        const ccIV  = Math.sqrt(ccVar / Math.max(T, 1e-8));
        console.debug("[b76 node] args", {
        F: trade.forward,
        K: trade.strike,
        T: Math.max(T, 1e-8),
        sigma: ccIV,
        isCall: trade.optionType === 'C'
        });
        const greeks = black76Greeks(trade.forward, trade.strike, Math.max(T, 1e-8), ccIV, trade.optionType === 'C', 1.0);
        const widthRef = this.riskScorer.computeWidth({ gamma: greeks.gamma });
      
        // Bucket at trade time (using CC IV)
        const bucket = DeltaConventions.strikeToBucket(trade.strike, trade.forward, ccIV, Math.max(T, 1e-8));
      
        if (!node) {
          node = {
            strike: trade.strike,
            pcAnchor: trade.price,
            widthRef,
            position: trade.size,   // sign convention: your engine uses negative for short; adjust if needed
            lastBucket: bucket,
            lastTradeTime: trade.time
          };
          surface.nodes.set(trade.strike, node);
        } else {
          node.pcAnchor = trade.price;
          node.position += trade.size;
          node.widthRef = widthRef;
          node.lastBucket = bucket;
          node.lastTradeTime = trade.time;
        }
      }
      
    
    calibrateFromMarket(
      expiry: number,
      marketQuotes: MarketQuoteForCalibration[],
      spot: number
    ): void {
      if (marketQuotes.length === 0) {
        console.warn('No market quotes provided for calibration');
        return;
      }
      
      const atmQuote = marketQuotes.reduce((closest, q) => 
        Math.abs(q.strike - spot) < Math.abs(closest.strike - spot) ? q : closest
      );
      
      console.log(`Calibrating from market: ATM strike=${atmQuote.strike}, IV=${(atmQuote.iv*100).toFixed(1)}%`);
      
      this.marketIVs.set(expiry, atmQuote.iv);
      
      const metrics = this.deriveMetricsFromMarketIV(atmQuote.iv, expiry);
      
      this.updateCC(expiry, metrics);
    }
    
    getQuote(
        expiryMs: number,
        strike: number,
        forward: number,
        optionType: 'C' | 'P',
        marketIV?: number
      ): Quote {
        // --- safety helpers (scoped to this call) ---
        const tiny = 1e-12;
        const safe = (x: number, fallback = 0) => (Number.isFinite(x) ? x : fallback);
      
        const isCall = optionType === 'C';
      
        // 1) Time to expiry (never let it be <= 0)
        const Traw = timeToExpiryYears(expiryMs);
        const T = Math.max(safe(Traw, 0), 1e-8);
      
        // 2) Ensure a surface exists (and is in sync with ATM IV if provided)
        let surface = this.surfaces.get(expiryMs);
      
        // ATM IV handling + recalibration decision
        let atmIV: number;
        let shouldRecalibrate = false;
        if (marketIV !== undefined) {
          atmIV = marketIV;
          const cached = this.marketIVs.get(expiryMs);
          if (!cached || Math.abs(atmIV - cached) > 0.01) {
            this.marketIVs.set(expiryMs, atmIV);
            shouldRecalibrate = true;
          }
        } else if (this.marketIVs.has(expiryMs)) {
          atmIV = this.marketIVs.get(expiryMs)!;
        } else {
          atmIV = 0.35; // fallback
        }
      
        if (!surface || shouldRecalibrate) {
          const initialMetrics = this.deriveMetricsFromMarketIV(atmIV, T);
          this.updateCC(expiryMs, initialMetrics);               // creates/updates surface.cc
          surface = this.surfaces.get(expiryMs)!;
          this.updatePC(surface);                                 // build inventory-aware PC from CC
        }
      
        // 3) Log-moneyness wrt forward (guard against weird inputs)
        let k = safe(Math.log(strike / Math.max(forward, tiny)), 0);
      
        // 4) Core curve (CC): variance → IV → Black-76 price
        let ccVar = safe(SVI.w(surface.cc, k), tiny);
        ccVar = Math.max(ccVar, tiny);
      
        let ccIV = safe(Math.sqrt(ccVar / T), 0);
        ccIV = Math.max(ccIV, 1e-8);
      
        console.debug("[b76 cc] args", { F: forward, K: strike, T, sigma: ccIV, isCall });
        const ccG = black76Greeks(forward, strike, T, ccIV, isCall, 1.0);
        const ccMid = safe(ccG.price, 0);
      
        // 5) Price curve (PC): variance → IV → Black-76 price
        let pcVar = safe(SVI.w(surface.pc, k), tiny);
        pcVar = Math.max(pcVar, tiny);
      
        let pcIV = safe(Math.sqrt(pcVar / T), 0);
        pcIV = Math.max(pcIV, 1e-8);
      
        console.debug("[b76 pc] args", { F: forward, K: strike, T, sigma: pcIV, isCall });
        const pcG = black76Greeks(forward, strike, T, pcIV, isCall, 1.0);
        const pcMid = safe(pcG.price, 0);

        const sanePrice = (p: number) =>
        Number.isFinite(p) && p >= 0 && p <= Math.max(forward, strike) * 2; // option price must be <= O(forward)
        const proxyMid = (iv: number) => forward * iv * Math.sqrt(T) * 0.4;   // simple convexity proxy

        if (!sanePrice(ccMid)) {
        console.warn("[ISM.getQuote] ccMid insane; clamping via proxy", { ccMid, forward, strike, T, ccIV });
        ccMid = proxyMid(ccIV);
        }
        if (!sanePrice(pcMid)) {
        console.warn("[ISM.getQuote] pcMid insane; clamping via proxy", { pcMid, forward, strike, T, pcIV });
        pcMid = proxyMid(pcIV);
        }
      
        // 6) Bucket (put-delta convention) for inventory/sizing
        const bucket = DeltaConventions.strikeToBucket(strike, forward, ccIV, T);
      
        // 7) Ensure a node exists & persist it (anchor/widthRef/position)
        let node = surface.nodes.get(strike);
        if (!node) {
          node = {
            strike,
            pcAnchor: pcMid,
            widthRef: this.riskScorer.computeWidth({ gamma: ccG.gamma }),
            position: 0,
            lastBucket: bucket,
            lastTradeTime: Date.now(),
          };
          surface.nodes.set(strike, node);
        }
      
        // 8) Compute current width (half-spread) from risk scorer
        const currentWidth = this.riskScorer.computeWidth({
          gamma: pcG.gamma,
          J_L0: 1.0,
          J_S0: 0.5,
          J_C0: 0.3,
        });
      
        // 9) Cash quotes (clamp bid ≥ 0)
        const bid = Math.max(0, pcMid - currentWidth);
        const ask = pcMid + currentWidth;
        const edge = pcMid - ccMid;
      
        // 10) Size logic (inventory-aware)
        const baseSize = this.config.quotes.sizeBlocks;
        const invState = this.inventoryController.getInventoryState();
        const bucketInv = invState.get(bucket as any); // depending on your Inventory type signature
      
        let bidSize = baseSize;
        let askSize = baseSize;
      
        if (bucketInv && typeof (bucketInv as any).vega === 'number') {
          const vegaSigned = (bucketInv as any).vega as number;
          const vref =
            this.config.buckets.find((b) => b.name === bucket)?.edgeParams.Vref ?? 100;
          const invRatio = Math.min(5, Math.abs(vegaSigned) / Math.max(vref, 1e-6));
      
          // If we are short vega in this bucket, reduce ask size (discourage more selling)
          if (vegaSigned < 0) {
            askSize = Math.max(10, Math.round(baseSize * Math.exp(-invRatio)));
          } else if (vegaSigned > 0) {
            bidSize = Math.max(10, Math.round(baseSize * Math.exp(-invRatio)));
          }
        }
      
        return {
          bid,
          ask,
          bidSize,
          askSize,
          pcMid,
          ccMid,
          edge,
          bucket,
        };
      }
    
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
    
    updateMarketObservations(observations: any[]): void {
      this.riskScorer.updateFromMarket(observations);
    }
    
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