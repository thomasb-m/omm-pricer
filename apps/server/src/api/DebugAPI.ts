// apps/server/src/api/DebugAPI.ts
/**
 * Debug API: Real-time diagnostic endpoints
 * 
 * Endpoints:
 * - GET /debug/state          - Current system state
 * - GET /debug/quote/:symbol  - Last quote decision
 * - GET /debug/history        - Recent trades/decisions
 * - GET /debug/config         - Current configuration
 * - GET /debug/abtest         - A/B test results
 */

import express, { Request, Response } from 'express';
import { SigmaService } from '../risk/SigmaService';
import { FactorRisk } from '../risk/FactorRisk';
import { QuoteExplanation } from '../engine/QuoteExplainer';
import { FeatureConfig } from '../config/featureFlags';
import { FACTOR_LABELS } from '../risk/factors/index.js';
import { ABTestResult } from '../testing/ABTestRunner';

export type TradeRecord = {
  timestamp: number;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  edge: number;
  configVersion: string;
};

export type QuoteRecord = {
  timestamp: number;
  symbol: string;
  explanation: QuoteExplanation;
  configVersion: string;
};

export class DebugAPI {
  private app: express.Application;
  private port: number;
  
  // Services
  private sigmaService: SigmaService;
  private factorRisk: FactorRisk;
  private config: FeatureConfig;
  
  // State tracking
  private inventory: number[];
  private lastQuotes: Map<string, QuoteRecord> = new Map();
  private recentTrades: TradeRecord[] = [];
  private recentQuotes: QuoteRecord[] = [];
  private maxHistory: number = 100;
  
  // A/B test results
  private lastABTest: ABTestResult | null = null;
  
  constructor(
    port: number,
    sigmaService: SigmaService,
    factorRisk: FactorRisk,
    config: FeatureConfig,
    inventory: number[]
  ) {
    this.port = port;
    this.sigmaService = sigmaService;
    this.factorRisk = factorRisk;
    this.config = config;
    this.inventory = inventory;
    
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }
  
  private setupRoutes(): void {
    // CORS for local development
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      next();
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });
    
    // Current system state
    this.app.get('/debug/state', (req, res) => this.getState(req, res));
    
    // Last quote for symbol
    this.app.get('/debug/quote/:symbol', (req, res) => this.getQuote(req, res));
    
    // Recent history
    this.app.get('/debug/history', (req, res) => this.getHistory(req, res));
    
    // Current config
    this.app.get('/debug/config', (req, res) => this.getConfig(req, res));
    
    // All last quotes
    this.app.get('/debug/quotes', (req, res) => this.getAllQuotes(req, res));
    
    // A/B test results
    this.app.get('/debug/abtest', (req, res) => this.getABTest(req, res));
  }
  
  /**
   * GET /debug/state
   * Returns current system state
   */
  private getState(req: Request, res: Response): void {
    const sigmaStats = this.sigmaService.getStats();
    const invUtil = this.factorRisk.getInventoryUtilization();
    
    res.json({
      timestamp: Date.now(),
      configVersion: this.config.version,
      
      inventory: {
        vector: this.inventory,
        labels: FACTOR_LABELS,
        utilization: invUtil,
        limit: this.config.risk.L,
      },
      
      sigma: {
        ready: this.sigmaService.isReady(),
        samples: sigmaStats.sampleCount,
        trace: sigmaStats.traceValue,
        conditionNumber: sigmaStats.conditionNumber,
        isPD: sigmaStats.isPD,
        minDiagonal: sigmaStats.minDiagonal,
        maxDiagonal: sigmaStats.maxDiagonal,
      },
      
      risk: {
        gamma: this.config.risk.gamma,
        z: this.config.risk.z,
        eta: this.config.risk.eta,
        kappa: this.config.risk.kappa,
      },
      
      features: this.config.features,
    });
  }
  
  /**
   * GET /debug/quote/:symbol
   * Returns last quote decision for symbol
   */
  private getQuote(req: Request, res: Response): void {
    const symbol = req.params.symbol;
    const record = this.lastQuotes.get(symbol);
    
    if (!record) {
      res.status(404).json({ error: `No quote found for ${symbol}` });
      return;
    }
    
    res.json({
      symbol,
      timestamp: record.timestamp,
      configVersion: record.configVersion,
      explanation: record.explanation,
    });
  }
  
  /**
   * GET /debug/history?type=trades|quotes&limit=N
   * Returns recent trades or quotes
   */
  private getHistory(req: Request, res: Response): void {
    const type = req.query.type as string || 'both';
    const limit = parseInt(req.query.limit as string || '20');
    
    const response: any = {
      timestamp: Date.now(),
      limit,
    };
    
    if (type === 'trades' || type === 'both') {
      response.trades = this.recentTrades.slice(-limit);
    }
    
    if (type === 'quotes' || type === 'both') {
      response.quotes = this.recentQuotes.slice(-limit);
    }
    
    res.json(response);
  }
  
  /**
   * GET /debug/config
   * Returns current configuration
   */
  private getConfig(req: Request, res: Response): void {
    res.json({
      timestamp: Date.now(),
      config: this.config,
    });
  }
  
  /**
   * GET /debug/quotes
   * Returns all last quotes (one per symbol)
   */
  private getAllQuotes(req: Request, res: Response): void {
    const quotes = Array.from(this.lastQuotes.entries()).map(([symbol, record]) => ({
      symbol,
      timestamp: record.timestamp,
      decision: record.explanation.decision,
      theo: record.explanation.theo,
      mid: record.explanation.mid,
      edge: record.explanation.edge,
      bid: record.explanation.breakdown?.theoInv ? 
        record.explanation.breakdown.theoInv - (record.explanation.breakdown.spread?.total || 0) : null,
      ask: record.explanation.breakdown?.theoInv ?
        record.explanation.breakdown.theoInv + (record.explanation.breakdown.spread?.total || 0) : null,
      size: record.explanation.breakdown?.size.final,
    }));
    
    res.json({
      timestamp: Date.now(),
      quotes,
    });
  }
  
  /**
   * GET /debug/abtest
   * Returns last A/B test result
   */
  private getABTest(req: Request, res: Response): void {
    if (!this.lastABTest) {
      res.status(404).json({ error: 'No A/B test results available' });
      return;
    }
    
    res.json(this.lastABTest);
  }
  
  /**
   * Record a quote decision
   */
  recordQuote(symbol: string, explanation: QuoteExplanation): void {
    const record: QuoteRecord = {
      timestamp: Date.now(),
      symbol,
      explanation,
      configVersion: this.config.version,
    };
    
    this.lastQuotes.set(symbol, record);
    this.recentQuotes.push(record);
    
    // Trim history
    if (this.recentQuotes.length > this.maxHistory) {
      this.recentQuotes.shift();
    }
  }
  
  /**
   * Record a trade
   */
  recordTrade(trade: Omit<TradeRecord, 'configVersion'>): void {
    const record: TradeRecord = {
      ...trade,
      configVersion: this.config.version,
    };
    
    this.recentTrades.push(record);
    
    // Trim history
    if (this.recentTrades.length > this.maxHistory) {
      this.recentTrades.shift();
    }
  }
  
  /**
   * Record A/B test result
   */
  recordABTest(result: ABTestResult): void {
    this.lastABTest = result;
  }
  
  /**
   * Update inventory reference (called after each trade)
   */
  updateInventory(inventory: number[]): void {
    this.inventory = inventory;
  }
  
  /**
   * Start the API server
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(this.port, () => {
        console.log(`📡 Debug API listening on http://localhost:${this.port}`);
        console.log(`   GET /debug/state`);
        console.log(`   GET /debug/quote/:symbol`);
        console.log(`   GET /debug/history`);
        console.log(`   GET /debug/config`);
        console.log(`   GET /debug/quotes`);
        console.log(`   GET /debug/abtest`);
        resolve();
      });
    });
  }
  
  /**
   * Stop the API server
   */
  stop(): void {
    // Express doesn't expose server handle easily, but in production use:
    // this.server.close();
  }
}