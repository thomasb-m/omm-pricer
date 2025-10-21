// apps/server/src/api/http.ts
/**
 * Phase 2: HTTP and WebSocket API endpoints
 * 
 * Routes:
 * - GET  /quotes       - Current quote state
 * - GET  /positions    - Current inventory
 * - GET  /pnl          - PnL breakdown
 * - GET  /risk         - Risk diagnostics (Σ, Λ, condition numbers)
 * - GET  /events       - Recent events/warnings
 * - WS   /stream       - Real-time updates
 */

import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';

// Import your services (adjust paths as needed)
import { SigmaService } from '../risk/SigmaService.js';
import { FactorRisk } from '../risk/FactorRisk.js';
import { FACTORS, FACTOR_LABELS, d } from '../risk/factors.js';

// Placeholder types - replace with your actual types
type QuoteState = {
  ts: number;
  quotes: Array<{
    symbol: string;
    bid: number;
    ask: number;
    sizeBid: number;
    sizeAsk: number;
    spread: number;
    skew: number;
    invUtil: number;
  }>;
};

type PositionState = {
  ts: number;
  positions: Array<{
    symbol: string;
    qty: number;
    notional: number;
    vega: number;
    gamma: number;
  }>;
  inventory: {
    labels: string[];
    values: number[];
  };
  lambda: {
    labels: string[];
    values: number[];
  };
  utilization: number;
};

type PnLState = {
  ts: number;
  realized: number;
  unrealized: number;
  total: number;
  breakdown: {
    edge: number;
    carry: number;
    fees: number;
    slippage: number;
    residual: number;
  };
};

type RiskState = {
  ts: number;
  factorVersion: number;
  sigma: {
    labels: string[];
    matrix: number[][];
    trace: number;
    conditionNumber: number;
    isPD: boolean;
    eigenvalues?: number[];
  };
  lambda: {
    conditionNumber: number;
    maxNorm: number;
  };
  config: {
    gamma: number;
    z: number;
    eta: number;
    kappa: number;
    L: number;
  };
};

type EventRecord = {
  ts: number;
  level: string;
  code: string;
  message: string;
  meta?: any;
};

/**
 * API Service - manages state and exposes endpoints
 */
export class APIService {
  private app: express.Application;
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  
  // Service dependencies (inject these)
  private sigmaService: SigmaService;
  private factorRisk: FactorRisk;
  
  // In-memory state (replace with your actual state management)
  private currentQuotes: QuoteState;
  private currentPositions: PositionState;
  private currentPnL: PnLState;
  private recentEvents: EventRecord[] = [];
  
  constructor(
    sigmaService: SigmaService,
    factorRisk: FactorRisk
  ) {
    this.sigmaService = sigmaService;
    this.factorRisk = factorRisk;
    
    this.app = express();
    this.app.use(express.json());
    
    // Initialize empty state
    this.currentQuotes = { ts: Date.now(), quotes: [] };
    this.currentPositions = {
      ts: Date.now(),
      positions: [],
      inventory: { labels: [], values: [] },
      lambda: { labels: [], values: [] },
      utilization: 0,
    };
    this.currentPnL = {
      ts: Date.now(),
      realized: 0,
      unrealized: 0,
      total: 0,
      breakdown: { edge: 0, carry: 0, fees: 0, slippage: 0, residual: 0 },
    };
    
    this.setupRoutes();
  }
  
  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', ts: Date.now() });
    });
    
    // Quotes
    this.app.get('/quotes', (req: Request, res: Response) => {
      res.json(this.currentQuotes);
    });
    
    // Positions
    this.app.get('/positions', (req: Request, res: Response) => {
      res.json(this.currentPositions);
    });
    
    // PnL
    this.app.get('/pnl', (req: Request, res: Response) => {
      res.json(this.currentPnL);
    });
    
    // Risk diagnostics
    this.app.get('/risk', (req: Request, res: Response) => {
      const risk = this.getRiskState();
      res.json(risk);
    });
    
    // Events
    this.app.get('/events', (req: Request, res: Response) => {
      const limit = parseInt(req.query.limit as string) || 100;
      const level = req.query.level as string | undefined;
      
      let events = this.recentEvents;
      if (level) {
        events = events.filter(e => e.level === level);
      }
      
      res.json({
        ts: Date.now(),
        events: events.slice(-limit),
      });
    });
    
    // Factor registry info
    this.app.get('/factors', (req: Request, res: Response) => {
      res.json({
        version: FACTORS.version,
        dimension: d,
        factors: FACTORS.specs.map(s => ({
          label: s.label,
          unit: s.unit,
          description: s.description,
          enabled: s.enabled ?? true,
        })),
      });
    });
  }
  
  /**
   * Start HTTP server
   */
  start(port: number): Server {
    const server = this.app.listen(port, () => {
      console.log(`[API] HTTP server listening on port ${port}`);
    });
    
    // Setup WebSocket
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (ws: WebSocket) => {
      console.log('[API] WebSocket client connected');
      this.clients.add(ws);
      
      // Send initial state
      ws.send(JSON.stringify({
        type: 'snapshot',
        quotes: this.currentQuotes,
        positions: this.currentPositions,
        pnl: this.currentPnL,
      }));
      
      ws.on('close', () => {
        console.log('[API] WebSocket client disconnected');
        this.clients.delete(ws);
      });
      
      ws.on('error', (err) => {
        console.error('[API] WebSocket error:', err);
        this.clients.delete(ws);
      });
    });
    
    return server;
  }
  
  /**
   * Update state and broadcast to clients
   */
  updateQuotes(quotes: QuoteState): void {
    this.currentQuotes = quotes;
    this.broadcast({ type: 'quotes', data: quotes });
  }
  
  updatePositions(positions: PositionState): void {
    this.currentPositions = positions;
    this.broadcast({ type: 'positions', data: positions });
  }
  
  updatePnL(pnl: PnLState): void {
    this.currentPnL = pnl;
    this.broadcast({ type: 'pnl', data: pnl });
  }
  
  addEvent(event: EventRecord): void {
    this.recentEvents.push(event);
    
    // Keep only last 1000 events in memory
    if (this.recentEvents.length > 1000) {
      this.recentEvents = this.recentEvents.slice(-1000);
    }
    
    this.broadcast({ type: 'event', data: event });
  }
  
  private broadcast(message: any): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
  
  private getRiskState(): RiskState {
    const sigmaStats = this.sigmaService.getStats();
    const sigma = this.sigmaService.getSigma();
    const Lambda = this.factorRisk.getLambda();
    
    let lambdaCondition = 1;
    let lambdaMaxNorm = 0;
    if (Lambda) {
      // Compute Lambda diagnostics (simplified)
      lambdaCondition = sigmaStats.conditionNumber; // Approximation
      for (let i = 0; i < d; i++) {
        lambdaMaxNorm = Math.max(lambdaMaxNorm, Lambda[i][i]);
      }
    }
    
    return {
      ts: Date.now(),
      factorVersion: FACTORS.version,
      sigma: {
        labels: [...FACTOR_LABELS],
        matrix: sigma.matrix,
        trace: sigmaStats.traceValue,
        conditionNumber: sigmaStats.conditionNumber,
        isPD: sigmaStats.isPD,
      },
      lambda: {
        conditionNumber: lambdaCondition,
        maxNorm: lambdaMaxNorm,
      },
      config: {
        gamma: 1.0, // TODO: Get from config
        z: 1.0,
        eta: 1.0,
        kappa: 0.5,
        L: 1.0,
      },
    };
  }
}

/**
 * Example usage:
 * 
 * const sigmaService = new SigmaService(sigmaConfig);
 * const factorRisk = new FactorRisk(riskConfig);
 * const api = new APIService(sigmaService, factorRisk);
 * 
 * api.start(3000);
 * 
 * // In your main loop:
 * api.updateQuotes({ ts: Date.now(), quotes: [...] });
 * api.updatePositions({ ts: Date.now(), positions: [...], ... });
 * api.updatePnL({ ts: Date.now(), realized: 100, ... });
 * api.addEvent({ ts: Date.now(), level: 'warn', code: 'SIGMA_ILL_CONDITIONED', message: '...' });
 */