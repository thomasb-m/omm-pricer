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
      return { L0, S0: -0.02, C0: 0.5, S_neg: -0.8, S_pos: 0.9 };
    }
  
    private convertToSVIConfig(mc: ModelConfig): any {
      const edgeParams = new Map();
      mc.buckets.forEach(bucket => { edgeParams.set(bucket.name, bucket.edgeParams); });
      return {
        bMin: mc.svi.bMin,
        sigmaMin: mc.svi.sigmaMin,
        rhoMax: mc.svi.rhoMax,
        sMax: mc.svi.slopeMax,
        c0Min: mc.svi.c0Min,
        buckets: mc.buckets.map(b => ({ name: b.name, minDelta: b.minDelta, maxDelta: b.maxDelta })),
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
      if (!SVI.validate(newCC, this.sviConfig)) throw new Error('Invalid SVI parameters');
  
      let surface = this.surfaces.get(expiry);
      if (!surface) {
        surface = { expiry, cc: newCC, pc: newCC, nodes: new Map() };
        this.surfaces.set(expiry, surface);
      } else {
        surface.cc = newCC;
        this.updatePC(surface);
      }
      this.version++;
    }
  
    private updatePC(surface: EnhancedSurface): void {
      // legacy PC bumping (kept). PC will be *overridden* by refreshPCForMarket() on quote.
      surface.pc = this.inventoryController.adjustSVIForInventory(surface.cc);
    }
  
    onTrade(trade: TradeExecution): void {
      const surface = this.surfaces.get(trade.expiryMs);
      if (!surface) { console.warn(`No surface for expiryMs=${trade.expiryMs}`); return; }
  
      const T = timeToExpiryYears(trade.expiryMs, trade.time ?? Date.now());
      if (T <= 0) { console.warn(`Expired trade ignored (T<=0):`, trade); return; }
  
      const F = trade.forward;
      const K = trade.strike;
  
      this.updateNodeState(surface, {
        strike: K,
        price: trade.price,
        size: trade.size,
        expiryMs: trade.expiryMs,
        forward: F,
        optionType: trade.optionType,
        time: trade.time ?? Date.now(),
      } as any);
  
      const k = Math.log(K / F);
      const ccVar = SVI.w(surface.cc, k);
      const ccIV  = Math.sqrt(ccVar / T);
  
      const greeks = black76Greeks(F, K, T, ccIV, trade.optionType === 'C', 1.0);
  
      const bucket = DeltaConventions.strikeToBucket(K, F, ccIV, T);
  
      // Customer BUY => we SELL => our signed position is short → flip sign here
      this.inventoryController.updateInventory(
        K,
        -trade.size,
        greeks.vega,
        bucket
      );
  
      // recompute PC from inventory-aware adjustments (legacy path)
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
  
      const T = timeToExpiryYears(trade.expiryMs, trade.time);
      const k = Math.log(trade.strike / trade.forward);
      const ccVar = SVI.w(surface.cc, k);
      const ccIV  = Math.sqrt(ccVar / Math.max(T, 1e-8));
      const greeks = black76Greeks(trade.forward, trade.strike, Math.max(T, 1e-8), ccIV, trade.optionType === 'C', 1.0);
      const widthRef = this.riskScorer.computeWidth({ gamma: greeks.gamma });
  
      const bucket = DeltaConventions.strikeToBucket(trade.strike, trade.forward, ccIV, Math.max(T, 1e-8));
  
      if (!node) {
        node = {
          strike: trade.strike,
          pcAnchor: trade.price,
          widthRef,
          position: trade.size,
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
  
    calibrateFromMarket(expiry: number, marketQuotes: MarketQuoteForCalibration[], spot: number): void {
      if (marketQuotes.length === 0) { console.warn('No market quotes provided for calibration'); return; }
  
      const atmQuote = marketQuotes.reduce((closest, q) =>
        Math.abs(q.strike - spot) < Math.abs(closest.strike - spot) ? q : closest
      );
  
      console.log(`Calibrating from market: ATM strike=${atmQuote.strike}, IV=${(atmQuote.iv*100).toFixed(1)}%`);
      this.marketIVs.set(expiry, atmQuote.iv);
  
      const metrics = this.deriveMetricsFromMarketIV(atmQuote.iv, expiry);
      this.updateCC(expiry, metrics);
    }
  
    // ====== NEW: live projection of held risk → rebuild PC for current F/T ======
  
    private projectBucketVega(
      surface: EnhancedSurface,
      forward: number,
      nowMs: number
    ): Map<string, { vega: number; strikes: number[] }> {
      const out = new Map<string, { vega: number; strikes: number[] }>();
      const T = Math.max(timeToExpiryYears(surface.expiry, nowMs), 1e-8);
  
      for (const [K, node] of surface.nodes) {
        if (!node || !Number.isFinite(node.position) || node.position === 0) continue;
  
        const k = Math.log(K / Math.max(forward, 1e-12));
        const w = Math.max(SVI.w(surface.cc, k), 1e-12);
        const iv = Math.max(Math.sqrt(w / T), 1e-8);
  
        const g = black76Greeks(forward, K, T, iv, /*isCall*/ false, 1.0);
        const bucket = DeltaConventions.strikeToBucket(K, forward, iv, T);
  
        // node.position reflects *customer* signed size. We want our signed vega:
        const signedVegaForUs = -node.position * g.vega;
  
        const cur = out.get(bucket) ?? { vega: 0, strikes: [] };
        cur.vega += signedVegaForUs;
        if (cur.strikes.length < 5) cur.strikes.push(K);
        out.set(bucket, cur);
      }
  
      return out;
    }
  
    private rebuildPCFromProjection(
      surface: EnhancedSurface,
      forward: number,
      nowMs: number
    ): void {
      const T = Math.max(timeToExpiryYears(surface.expiry, nowMs), 1e-8);
      const F = forward;
  
      const proj = this.projectBucketVega(surface, F, nowMs);
  
      const bumps: Array<{ k: number; alpha: number; lam: number; bucket: string }> = [];
  
      for (const [bucket, { vega, strikes }] of proj) {
        if (Math.abs(vega) < 1e-6) continue;
  
        const edgeTicks = this.inventoryController.getRequiredEdgeForBucket(bucket, vega);
        if (Math.abs(edgeTicks) < 1e-6) continue;
  
        const targets: Array<{ k: number; deltaW: number }> = [];
        const centers: number[] = [];
  
        const anchors = strikes.length ? strikes : [F];
        for (const K of anchors) {
          const k = Math.log(K / Math.max(F, 1e-12));
          const w = Math.max(SVI.w(surface.cc, k), 1e-12);
          const iv = Math.sqrt(w / T);
  
          const g = black76Greeks(F, K, T, iv, /*isCall*/ false, 1.0);
  
          const priceEdge = edgeTicks * (this.config.ticks?.optionTickValue ?? 1.0);
          const dVol = priceEdge / Math.max(g.vega, 1e-6);
          const dW = 2 * iv * T * dVol;
  
          targets.push({ k, deltaW: dW });
          centers.push(k);
        }
  
        const width = this.config.rbf.width;
        const ridge = this.config.rbf.ridgeLambda;
        const alphas = this.inventoryController.solveRbfAlphas(targets, centers, width, ridge);
  
        for (let i = 0; i < centers.length; i++) {
          const a = alphas[i];
          if (Math.abs(a) > 1e-9) {
            bumps.push({ k: centers[i], alpha: a, lam: width * 0.5, bucket });
          }
        }
      }
  
      surface.pc = SVI.applyBumps(surface.cc, bumps);
    }
  
    private refreshPCForMarket(surface: EnhancedSurface, forward: number, nowMs: number): void {
      // CC remains untouched; PC rebuilt from *today’s* risk projection.
      this.rebuildPCFromProjection(surface, forward, nowMs);
    }
  
    // ====== /NEW ======
  
    getQuote(
      expiryMs: number,
      strike: number,
      forward: number,
      optionType: 'C' | 'P',
      marketIV?: number
    ): Quote {
      const tiny = 1e-12;
      const safe = (x: number, fallback = 0) => (Number.isFinite(x) ? x : fallback);
      const isCall = optionType === 'C';
  
      const Traw = timeToExpiryYears(expiryMs);
      const T = Math.max(safe(Traw, 0), 1e-8);
  
      let surface = this.surfaces.get(expiryMs);
  
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
        atmIV = 0.35;
      }
  
      if (!surface || shouldRecalibrate) {
        const initialMetrics = this.deriveMetricsFromMarketIV(atmIV, T);
        this.updateCC(expiryMs, initialMetrics);
        surface = this.surfaces.get(expiryMs)!;
        this.updatePC(surface);
      }
  
      // --- NEW: make PC reflect current F/T and current inventory every quote
      this.refreshPCForMarket(surface, forward, Date.now());
  
      let k = safe(Math.log(strike / Math.max(forward, tiny)), 0);
  
      // CC pricing
      let ccVar = safe(SVI.w(surface.cc, k), tiny); ccVar = Math.max(ccVar, tiny);
      let ccIV = safe(Math.sqrt(ccVar / T), 0);     ccIV = Math.max(ccIV, 1e-8);
      const ccG = black76Greeks(forward, strike, T, ccIV, isCall, 1.0);
      const ccMidBase = safe(ccG.price, 0);
  
      // PC pricing
      let pcVar = safe(SVI.w(surface.pc, k), tiny); pcVar = Math.max(pcVar, tiny);
      let pcIV = safe(Math.sqrt(pcVar / T), 0);     pcIV = Math.max(pcIV, 1e-8);
      const pcG = black76Greeks(forward, strike, T, pcIV, isCall, 1.0);
      const pcMidBase = safe(pcG.price, 0);
  
      const midIsSane = (p: number) => Number.isFinite(p) && p >= 0 && p <= Math.max(forward, strike) * 2;
      const proxyMid = (iv: number) => forward * iv * Math.sqrt(T) * 0.4;
  
      const ccMidCandidate = proxyMid ? proxyMid(ccIV) : ccMidBase;
      const pcMidCandidate = proxyMid ? proxyMid(pcIV) : pcMidBase;
  
      const ccMid = midIsSane(ccMidCandidate) ? ccMidCandidate : proxyMid(ccIV);
      const pcMid = midIsSane(pcMidCandidate) ? pcMidCandidate : proxyMid(pcIV);
  
      const bucket = DeltaConventions.strikeToBucket(strike, forward, ccIV, T);
  
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
  
      const currentWidth = this.riskScorer.computeWidth({
        gamma: pcG.gamma,
        J_L0: 1.0, J_S0: 0.5, J_C0: 0.3,
      });
  
      const bid = Math.max(0, pcMid - currentWidth);
      const ask = pcMid + currentWidth;
      const edge = pcMid - ccMid;
  
      const baseSize = this.config.quotes.sizeBlocks;
      const invState = this.inventoryController.getInventoryState();
      const bucketInv = (invState as any).get
        ? (invState as any).get(bucket)
        : undefined;
  
      let bidSize = baseSize;
      let askSize = baseSize;
  
      if (bucketInv && typeof (bucketInv as any).vega === 'number') {
        const vegaSigned = (bucketInv as any).vega as number;
        const vref = this.config.buckets.find((b) => b.name === bucket)?.edgeParams.Vref ?? 100;
        const invRatio = Math.min(5, Math.abs(vegaSigned) / Math.max(vref, 1e-6));
  
        if (vegaSigned < 0) {
          askSize = Math.max(10, Math.round(baseSize * Math.exp(-invRatio)));
        } else if (vegaSigned > 0) {
          bidSize = Math.max(10, Math.round(baseSize * Math.exp(-invRatio)));
        }
      }
  
      return { bid, ask, bidSize, askSize, pcMid, ccMid, edge, bucket };
    }
  
    getInventorySummary() {
      const invState = this.inventoryController.getInventoryState();
      const adjustments = this.inventoryController.calculateSmileAdjustments();
  
      const summary = { totalVega: 0, byBucket: {} as any, smileAdjustments: adjustments };
      for (const [bucket, inv] of invState) {
        summary.totalVega += inv.vega;
        summary.byBucket[bucket] = { vega: inv.vega, count: inv.count };
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
  
      const strikes = [spot * 0.80, spot * 0.90, spot * 0.95, spot * 1.00, spot * 1.05, spot * 1.10, spot * 1.20];
  
      for (const strike of strikes) {
        const k = Math.log(strike / spot);
        const ccVar = SVI.w(surface.cc, k);
        const pcVar = SVI.w(surface.pc, k);
  
        const ccVol = Math.sqrt(ccVar / expiry) * 100;
        const pcVol = Math.sqrt(pcVar / expiry) * 100;
  
        const ccPrice = blackScholes({ strike, spot, vol: ccVol / 100, T: expiry, r: 0, isCall: false }).price;
        const pcPrice = blackScholes({ strike, spot, vol: pcVol / 100, T: expiry, r: 0, isCall: false }).price;
  
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
  
    getCCSVI(expiryMs: number): SVIParams | null {
      const s = this.surfaces.get(expiryMs);
      return s ? s.cc : null;
    }
  }
  