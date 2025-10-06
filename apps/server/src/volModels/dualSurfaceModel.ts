/**
 * Dual Surface Volatility Model
 * Core implementation with CC (belief) and PC (price curve) separation
 */

// ============================================================================
// CORE DATA STRUCTURES
// ============================================================================

export interface SVIParams {
    a: number;
    b: number;
    rho: number;
    sigma: number;
    m: number;
  }
  
  export interface TraderMetrics {
    L0: number;    // ATM total variance
    S0: number;    // ATM skew
    C0: number;    // ATM curvature
    S_neg: number; // Left wing slope
    S_pos: number; // Right wing slope
  }
  
  export interface Bump {
    k: number;       // Center in log-moneyness
    alpha: number;   // Amplitude in variance space
    lam: number;     // Width parameter
    bucket: string;  // Delta bucket
  }
  
  export interface NodeState {
    strike: number;
    pcAnchor: number;      // Last traded price
    widthRef: number;      // Width when position established
    position: number;      // Signed size (negative = short)
    lastBucket: string;    // For detecting migrations
    lastTradeTime: number;
  }
  
  export interface Surface {
    expiry: number;           // Time to expiry in years
    cc: SVIParams;           // Core Curve (belief)
    pcBumps: Bump[];         // Price Curve adjustments
    nodes: Map<number, NodeState>;  // Strike -> NodeState
  }
  
  export interface DeltaBucket {
    name: string;
    minDelta: number;
    maxDelta: number;
  }
  
  export interface EdgeParams {
    E0: number;      // Base edge
    kappa: number;   // Scale factor
    gamma: number;   // Curvature
    Vref: number;    // Reference vega
  }
  
  export interface Config {
    // SVI bounds
    bMin: number;
    sigmaMin: number;
    rhoMax: number;
    sMax: number;
    c0Min: number;
    
    // Delta buckets
    buckets: DeltaBucket[];
    
    // Edge parameters per bucket
    edgeParams: Map<string, EdgeParams>;
    
    // RBF parameters
    rbfWidth: number;
    ridgeLambda: number;
    
    // Risk limits
    maxL0Move: number;
    maxS0Move: number;
    maxC0Move: number;
  }
  
  // ============================================================================
  // SVI FUNCTIONS
  // ============================================================================
  
  export class SVI {
    /**
     * Calculate total variance at log-moneyness k
     */
    static w(params: SVIParams, k: number): number {
      const z = k - params.m;
      return params.a + params.b * (params.rho * z + Math.sqrt(z * z + params.sigma * params.sigma));
    }
    
    /**
     * Validate SVI parameters against no-arbitrage constraints
     */
    static validate(params: SVIParams, config: Config): boolean {
      // Basic bounds
      if (params.b < config.bMin || params.sigma < config.sigmaMin) {
        return false;
      }
      if (Math.abs(params.rho) > config.rhoMax) {
        return false;
      }
      
      // ATM variance must be non-negative
      const L0 = params.a + params.b * params.sigma;
      if (L0 < 0) {
        return false;
      }
      
      // Wing slopes must be positive
      const sLeft = params.b * (1 - params.rho);
      const sRight = params.b * (1 + params.rho);
      if (sLeft <= 0 || sRight <= 0) {
        return false;
      }
      if (sLeft > config.sMax || sRight > config.sMax) {
        return false;
      }
      
      return true;
    }
    
    /**
     * Convert trader metrics to SVI parameters
     */
    static fromMetrics(
      metrics: TraderMetrics,
      config: Config,
      options?: { preserveBumps?: boolean }
    ): SVIParams {
      const eps = 1e-12;
      const rhoMax = config.rhoMax ?? 0.999;
      const c0Min  = config.c0Min  ?? 1e-8;
      const bMin   = config.bMin   ?? 1e-8;
      const sigmaMin = config.sigmaMin ?? 1e-8;
    
      const Sp = metrics.S_pos;
      const Sn = metrics.S_neg;
      const Ssum = Sp + Sn;
      const Sdiff = Sp - Sn;
    
      // Correct identities: b = (S_pos + S_neg)/2, rho = (S_pos - S_neg)/(S_pos + S_neg)
      let b_raw = 0.5 * Ssum;
      let rho_raw = Math.abs(Ssum) > eps ? Sdiff / Ssum : 0;
    
      // Optional: when wings are symmetric (Ssum≈0), use S0 = b·ρ to preserve S0 bumps
      if (options?.preserveBumps && Math.abs(Ssum) < 1e-6) {
        const b_safe = Math.abs(b_raw) > eps ? Math.abs(b_raw) : bMin;
        const rho_from_S0 = metrics.S0 / b_safe;
        rho_raw = 0.75 * rho_raw + 0.25 * rho_from_S0; // Blend 25% from S0
      }
    
      // Legalize without destroying bumps
      let b = Math.max(Math.abs(b_raw), bMin); // SVI requires b > 0
      let rho = Math.max(-rhoMax, Math.min(rhoMax, rho_raw));
      
      // C0 ≈ b/sigma => sigma ≈ b/C0
      const sigma_raw = b / Math.max(metrics.C0, c0Min);
      let sigma = Math.max(sigma_raw, sigmaMin);
      
      // L0 = a + b·sigma => a = L0 - b·sigma
      let a = metrics.L0 - b * sigma;
    
      return { a, b, rho, sigma, m: 0 };
    }  

    /**
     * Extract trader metrics from SVI parameters
     */
    static toMetrics(params: SVIParams): TraderMetrics {
      const L0 = params.a + params.b * params.sigma;
      const S0 = params.b * params.rho;
      const C0 = params.sigma > 0 ? params.b / params.sigma : 0;
      const S_neg = params.b * (1 - params.rho);
      const S_pos = params.b * (1 + params.rho);
      
      return { L0, S0, C0, S_neg, S_pos };
    }
  }  
  
  // ============================================================================
  // BUMP FUNCTIONS
  // ============================================================================
  
  export class BumpFunctions {
    /**
     * Evaluate Gaussian RBF bump at log-moneyness k
     */
    static evalBump(bump: Bump, k: number): number {
      return bump.alpha * Math.exp(-0.5 * Math.pow((k - bump.k) / bump.lam, 2));
    }
    
    /**
     * Evaluate all bumps at log-moneyness k
     */
    static evalBumps(bumps: Bump[], k: number): number {
      return bumps.reduce((sum, bump) => sum + this.evalBump(bump, k), 0);
    }
  }
  
  // ============================================================================
  // WIDTH-DELTA RULE
  // ============================================================================
  
  export class WidthDelta {
    /**
     * Calculate PC mid with width-delta adjustment
     */
    static getPCMid(
      node: NodeState,
      widthNow: number,
      ccMid: number,
      staleHours: number = 24
    ): number {
      if (node.position === 0) {
        return node.pcAnchor;
      }
      
      // Width-delta rule
      const signPos = node.position < 0 ? 1 : -1;
      const pcBase = node.pcAnchor + signPos * (widthNow - node.widthRef);
      
      // Optional: drift toward CC for stale positions
      if (staleHours > 0) {
        const ageHours = (Date.now() - node.lastTradeTime) / (3600 * 1000);
        const confidence = Math.exp(-ageHours / staleHours);
        return confidence * pcBase + (1 - confidence) * ccMid;
      }
      
      return pcBase;
    }
  }
  
  // ============================================================================
  // DELTA COMPUTATION
  // ============================================================================
  
  export class Greeks {
    /**
     * Compute Black-Scholes delta (simplified)
     */
    static delta(
      strike: number,
      spot: number,
      vol: number,
      T: number,
      isCall: boolean = false
    ): number {
      if (T <= 0) return 0;
      
      // Simplified BS delta (assuming r=0)
      const d1 = (Math.log(spot / strike) + 0.5 * vol * vol * T) / (vol * Math.sqrt(T));
      
      // Normal CDF approximation
      const normCdf = (x: number) => {
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const p = 0.3275911;
        
        const sign = x >= 0 ? 1 : -1;
        x = Math.abs(x) / Math.sqrt(2.0);
        
        const t = 1.0 / (1.0 + p * x);
        const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
        
        return 0.5 * (1.0 + sign * y);
      };
      
      const delta = isCall ? normCdf(d1) : normCdf(d1) - 1;
      return Math.abs(delta);
    }
    
    /**
     * Map delta to bucket
     */
    static getBucket(delta: number, config: Config): string {
      for (const bucket of config.buckets) {
        if (delta >= bucket.minDelta && delta <= bucket.maxDelta) {
          return bucket.name;
        }
      }
      return 'wings';  // Default for far OTM
    }
  }
  
  // ============================================================================
  // RISK SCORER
  // ============================================================================
  
  export interface MarketObservation {
    instrument: string;
    spread: number;
    gamma?: number;
    J_L0?: number;
    J_S0?: number;
    J_C0?: number;
  }
  
  export class RiskScorer {
    private betas: Map<string, number>;
    private lastUpdate: number;
    
    constructor() {
      this.betas = new Map([
        ['gamma', 1.0],
        ['L0', 1.0],
        ['S0', 0.5],
        ['C0', 0.3],
        ['floor', 0.5]
      ]);
      this.lastUpdate = Date.now();
    }
    
    /**
     * Update risk prices from market observations (simplified NNLS)
     */
    updateFromMarket(observations: MarketObservation[]): void {
      if (observations.length === 0) return;
      
      // Simplified update - in production would use proper NNLS
      const alpha = 0.3;  // EMA parameter
      
      // Average observed spreads by category
      const avgSpread = observations.reduce((sum, obs) => sum + obs.spread, 0) / observations.length;
      
      // Update floor
      this.betas.set('floor', 
        alpha * avgSpread * 0.5 + (1 - alpha) * this.betas.get('floor')!);
      
      this.lastUpdate = Date.now();
    }
    
    /**
     * Compute half-spread for a structure
     */
    computeWidth(greeks: Partial<{
      gamma: number;
      J_L0: number;
      J_S0: number;
      J_C0: number;
    }>): number {
      let width = this.betas.get('floor')!;
      
      if (greeks.gamma) {
        width += this.betas.get('gamma')! * Math.abs(greeks.gamma);
      }
      if (greeks.J_L0) {
        width += this.betas.get('L0')! * Math.abs(greeks.J_L0);
      }
      if (greeks.J_S0) {
        width += this.betas.get('S0')! * Math.abs(greeks.J_S0);
      }
      if (greeks.J_C0) {
        width += this.betas.get('C0')! * Math.abs(greeks.J_C0);
      }
      
      return width;
    }
  }
  
  // ============================================================================
  // SURFACE STATE MANAGER
  // ============================================================================
  
  export class DualSurfaceModel {
    private surfaces: Map<number, Surface>;
    private config: Config;
    private scorer: RiskScorer;
    private version: number;
    
    constructor(modelConfig: any) {
      this.surfaces = new Map();
      // Convert ModelConfig to Config format
      this.config = this.convertModelConfig(modelConfig);
      this.scorer = new RiskScorer();
      this.version = 0;
    }
    
    private convertModelConfig(mc: any): Config {
      // Map edge params from array to Map
      const edgeParams = new Map<string, EdgeParams>();
      mc.buckets.forEach((bucket: any) => {
        edgeParams.set(bucket.name, bucket.edgeParams);
      });
      
      return {
        bMin: mc.svi.bMin,
        sigmaMin: mc.svi.sigmaMin,
        rhoMax: mc.svi.rhoMax,
        sMax: mc.svi.slopeMax,
        c0Min: mc.svi.c0Min,
        buckets: mc.buckets.map((b: any) => ({
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
     * Initialize or update Core Curve
     */
    updateCC(expiry: number, metrics: TraderMetrics): void {
      const newCC = SVI.fromMetrics(metrics, this.config);
      
      if (!SVI.validate(newCC, this.config)) {
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
        // Rebase PC to maintain quotes
        // (Implementation would go here)
        surface.cc = newCC;
      }
      
      this.version++;
    }
    
    /**
     * Handle trade execution
     */
    onTrade(
      expiry: number,
      strike: number,
      price: number,
      size: number,
      spot: number
    ): void {
      const surface = this.surfaces.get(expiry);
      if (!surface) return;
      
      let node = surface.nodes.get(strike);
      if (!node) {
        // Create new node
        const vol = 0.3;  // Placeholder
        const delta = Greeks.delta(strike, spot, vol, expiry);
        
        node = {
          strike,
          pcAnchor: price,
          widthRef: this.scorer.computeWidth({ gamma: 0.1 }),
          position: -size,  // Negative for short
          lastBucket: Greeks.getBucket(delta, this.config),
          lastTradeTime: Date.now()
        };
        surface.nodes.set(strike, node);
      } else {
        // Update existing node
        node.pcAnchor = price;
        node.position -= size;
        node.lastTradeTime = Date.now();
      }
      
      this.version++;
    }
    
    /**
     * Get quotes for strikes
     */
    getQuotes(
      expiry: number,
      strikes: number[],
      spot: number
    ): Map<number, { bid: number; ask: number }> {
      const quotes = new Map<number, { bid: number; ask: number }>();
      const surface = this.surfaces.get(expiry);
      
      if (!surface) return quotes;
      
      for (const strike of strikes) {
        const k = Math.log(strike / spot);
        
        // Get or create node
        let node = surface.nodes.get(strike);
        if (!node) {
          const vol = 0.3;  // Placeholder
          const delta = Greeks.delta(strike, spot, vol, expiry);
          
          node = {
            strike,
            pcAnchor: 100 * vol * Math.sqrt(expiry) * 0.4,  // Rough approximation
            widthRef: 0.5,
            position: 0,
            lastBucket: Greeks.getBucket(delta, this.config),
            lastTradeTime: Date.now()
          };
        }
        
        // Compute current width
        const widthNow = this.scorer.computeWidth({ gamma: 0.1 });
        
        // Get PC mid with width-delta adjustment
        const ccMid = 100 * Math.sqrt(SVI.w(surface.cc, k) / expiry) * Math.sqrt(expiry) * 0.4;
        const pcMid = WidthDelta.getPCMid(node, widthNow, ccMid, 24);
        
        // Symmetric quotes
        quotes.set(strike, {
          bid: pcMid - widthNow,
          ask: pcMid + widthNow
        });
      }
      
      return quotes;
    }
    
    /**
     * Get current version for consistency checks
     */
    getVersion(): number {
      return this.version;
    }
  }
  
  // ============================================================================
  // DEFAULT CONFIGURATION
  // ============================================================================
  
  export function getDefaultConfig(): Config {
    const edgeParams = new Map<string, EdgeParams>([
      ['atm', { E0: 2.0, kappa: 5.0, gamma: 1.5, Vref: 100.0 }],
      ['rr25', { E0: 1.0, kappa: 3.0, gamma: 1.4, Vref: 100.0 }],
      ['rr10', { E0: 0.5, kappa: 2.0, gamma: 1.3, Vref: 100.0 }],
      ['wings', { E0: 0.3, kappa: 1.5, gamma: 1.2, Vref: 100.0 }]
    ]);
    
    return {
      bMin: 1e-6,
      sigmaMin: 1e-3,
      rhoMax: 0.995,
      sMax: 2.0,
      c0Min: 1e-4,
      
      buckets: [
        { name: 'atm', minDelta: 0.45, maxDelta: 0.55 },
        { name: 'rr25', minDelta: 0.20, maxDelta: 0.30 },
        { name: 'rr10', minDelta: 0.08, maxDelta: 0.12 },
        { name: 'wings', minDelta: 0.00, maxDelta: 0.05 }
      ],
      
      edgeParams,
      
      rbfWidth: 0.15,
      ridgeLambda: 1e-3,
      
      maxL0Move: 0.5,
      maxS0Move: 0.2,
      maxC0Move: 0.05
    };
  }