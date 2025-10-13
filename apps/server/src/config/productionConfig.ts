/**
 * Production Configuration
 * One-stop shop for all live trading parameters
 */

export interface ProductionConfig {
    // Environment
    environment: 'production' | 'staging' | 'testnet' | 'backtest';
    
    // Product
    product: 'BTC' | 'ETH' | 'SOL';
    venue: 'deribit' | 'okx' | 'binance';
    
    // Pricing core
    tick: number;
    
    // PC dynamics
    fillAnchorKappa: number;      // Usually 1.0
    fillAnchorGamma: number;      // Usually 1.0
    inventoryNudgeAlpha: number;  // 0.1
    
    // CC micro-alpha
    enableAlpha: boolean;
    alphaK: number;
    alphaMaxTicks: number;
    
    // Fees
    makerFee: number;             // Negative = rebate
    takerFee: number;
    
    // Limits
    maxNotionalPerMin: number;
    maxTradesPerMin: number;
    maxPositionNotional: number;
    maxInventoryLots: number;
    
    // Deribit specific
    mmpEnabled: boolean;
    mmpQtyWindow: number;
    mmpDeltaWindow: number;
    mmpVegaWindow: number;
    mmpInterval: number;
    postOnlyReject: boolean;
    stpEnabled: boolean;
    cancelOnDisconnect: boolean;
    
    // Delta-band pickoff defense
    deltaBandEnabled: boolean;
    deltaBandThreshold: number;   // c_h in GPT's spec
    deltaBandWindow: number;      // τ (ms)
    deltaBandHold: number;        // Hold time after trigger (ms)
    deltaBandGrace: number;       // Grace period (ms)
    
    // Monitoring
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    metricsIntervalMs: number;
    enableDiagnostics: boolean;
  }
  
  export const PRODUCTION_CONFIGS: Record<string, ProductionConfig> = {
    'btc-deribit-production': {
      environment: 'production',
      product: 'BTC',
      venue: 'deribit',
      
      tick: 0.0001,
      
      // PC dynamics (conservative)
      fillAnchorKappa: 1.0,
      fillAnchorGamma: 1.0,
      inventoryNudgeAlpha: 0.1,
      
      // Alpha (start disabled, enable in Phase 2)
      enableAlpha: false,
      alphaK: 0.05,
      alphaMaxTicks: 0.5,
      
      // Fees (Deribit BTC options)
      makerFee: -0.00003,          // 0.03% rebate
      takerFee: 0.00003,           // 0.03% fee
      
      // Limits
      maxNotionalPerMin: 50.0,
      maxTradesPerMin: 100,
      maxPositionNotional: 500.0,
      maxInventoryLots: 10000,
      
      // MMP
      mmpEnabled: true,
      mmpQtyWindow: 1000,
      mmpDeltaWindow: 100,
      mmpVegaWindow: 10000,
      mmpInterval: 1000,
      postOnlyReject: true,
      stpEnabled: true,
      cancelOnDisconnect: true,
      
      // Delta-band defense
      deltaBandEnabled: true,
      deltaBandThreshold: 0.8,
      deltaBandWindow: 100,
      deltaBandHold: 120,
      deltaBandGrace: 250,
      
      // Monitoring
      logLevel: 'info',
      metricsIntervalMs: 60000,
      enableDiagnostics: false
    },
    
    'btc-deribit-staging': {
      environment: 'staging',
      product: 'BTC',
      venue: 'deribit',
      
      tick: 0.0001,
      
      fillAnchorKappa: 1.0,
      fillAnchorGamma: 1.0,
      inventoryNudgeAlpha: 0.1,
      
      // Alpha enabled for testing
      enableAlpha: true,
      alphaK: 0.05,
      alphaMaxTicks: 0.5,
      
      makerFee: -0.00003,
      takerFee: 0.00003,
      
      // Tighter limits
      maxNotionalPerMin: 20.0,
      maxTradesPerMin: 50,
      maxPositionNotional: 100.0,
      maxInventoryLots: 2000,
      
      mmpEnabled: true,
      mmpQtyWindow: 500,
      mmpDeltaWindow: 50,
      mmpVegaWindow: 5000,
      mmpInterval: 500,
      postOnlyReject: true,
      stpEnabled: true,
      cancelOnDisconnect: true,
      
      deltaBandEnabled: true,
      deltaBandThreshold: 0.8,
      deltaBandWindow: 100,
      deltaBandHold: 120,
      deltaBandGrace: 250,
      
      logLevel: 'debug',
      metricsIntervalMs: 10000,
      enableDiagnostics: true
    },
    
    'btc-deribit-testnet': {
      environment: 'testnet',
      product: 'BTC',
      venue: 'deribit',
      
      tick: 0.0001,
      
      fillAnchorKappa: 1.0,
      fillAnchorGamma: 1.0,
      inventoryNudgeAlpha: 0.15,   // More aggressive
      
      // All features enabled
      enableAlpha: true,
      alphaK: 0.1,                  // Stronger signal
      alphaMaxTicks: 1.0,           // Larger nudge
      
      makerFee: -0.00003,
      takerFee: 0.00003,
      
      // Very tight limits (safe experimentation)
      maxNotionalPerMin: 5.0,
      maxTradesPerMin: 20,
      maxPositionNotional: 20.0,
      maxInventoryLots: 500,
      
      mmpEnabled: true,
      mmpQtyWindow: 100,
      mmpDeltaWindow: 10,
      mmpVegaWindow: 1000,
      mmpInterval: 500,
      postOnlyReject: true,
      stpEnabled: true,
      cancelOnDisconnect: true,
      
      deltaBandEnabled: true,
      deltaBandThreshold: 0.6,      // More defensive
      deltaBandWindow: 100,
      deltaBandHold: 150,
      deltaBandGrace: 300,
      
      logLevel: 'debug',
      metricsIntervalMs: 5000,
      enableDiagnostics: true
    },
    
    'backtest': {
      environment: 'backtest',
      product: 'BTC',
      venue: 'deribit',
      
      tick: 0.0001,
      
      fillAnchorKappa: 1.0,
      fillAnchorGamma: 1.0,
      inventoryNudgeAlpha: 0.1,
      
      enableAlpha: true,
      alphaK: 0.05,
      alphaMaxTicks: 0.5,
      
      makerFee: -0.00002,
      takerFee: 0.00002,
      
      maxNotionalPerMin: 999999,
      maxTradesPerMin: 999999,
      maxPositionNotional: 999999,
      maxInventoryLots: 999999,
      
      mmpEnabled: false,
      mmpQtyWindow: 0,
      mmpDeltaWindow: 0,
      mmpVegaWindow: 0,
      mmpInterval: 0,
      postOnlyReject: false,
      stpEnabled: false,
      cancelOnDisconnect: false,
      
      deltaBandEnabled: false,
      deltaBandThreshold: 0,
      deltaBandWindow: 0,
      deltaBandHold: 0,
      deltaBandGrace: 0,
      
      logLevel: 'warn',
      metricsIntervalMs: 0,
      enableDiagnostics: false
    }
  };
  
  /**
   * Get config by name (with fallback to testnet)
   */
  export function getProductionConfig(name: string): ProductionConfig {
    return PRODUCTION_CONFIGS[name] || PRODUCTION_CONFIGS['btc-deribit-testnet'];
  }
  
  /**
   * Load config from environment variable
   */
  export function loadConfigFromEnv(): ProductionConfig {
    const configName = process.env.TRADING_CONFIG || 'btc-deribit-testnet';
    return getProductionConfig(configName);
  }