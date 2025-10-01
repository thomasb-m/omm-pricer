/**
 * Corrected Adapter with Proper Trade Side Logic
 */

import { IntegratedSmileModel, TradeExecution } from './integratedSmileModel';

export type CustomerSide = 'BUY' | 'SELL';
export type MarketMakerPosition = 'LONG' | 'SHORT';

export class CorrectedAdapter {
  private model: IntegratedSmileModel;
  private spot: number;
  private expiry: number = 0.08;
  private debug: boolean = false;

  constructor(spot: number, debug: boolean = false) {
    this.spot = spot;
    this.debug = debug;
    this.model = new IntegratedSmileModel('BTC');
    if (this.debug) {
      console.log('Model initialized - surfaces will auto-create on first quote');
    }
  }

  updateSpot(newSpot: number): void {
    this.spot = newSpot;
    console.log(`CorrectedAdapter spot updated to ${newSpot}`);
  }

  getQuote(strike: number, expiry: number = this.expiry, marketIV?: number) {
    // Pass spot to the model's getQuote method
    return this.model.getQuote(expiry, strike, this.spot, marketIV);
  }

  executeCustomerTrade(
    strike: number, 
    expiry: number = this.expiry,
    customerSide: CustomerSide,
    size: number,
    price?: number
  ) {
    if (!price) {
      const quote = this.getQuote(strike, expiry);
      price = customerSide === 'BUY' ? quote.ask : quote.bid;
    }

    const ourPositionChange = customerSide === 'BUY' ? -size : size;
    const ourAction = customerSide === 'BUY' ? 'SELLING' : 'BUYING';
    const resultingPosition: MarketMakerPosition = customerSide === 'BUY' ? 'SHORT' : 'LONG';
    
    if (this.debug) {
      console.log(`\n📊 Trade Execution:`);
      console.log(`  Customer: ${customerSide}S ${size} @ ${price.toFixed(2)}`);
      console.log(`  We are: ${ourAction} (position change: ${ourPositionChange > 0 ? '+' : ''}${ourPositionChange})`);
      console.log(`  Result: Getting ${resultingPosition}`);
      console.log(`  Expected: Vols should ${resultingPosition === 'SHORT' ? 'RISE ↑' : 'FALL ↓'}`);
    }

    const trade: TradeExecution = {
      expiry,
      strike,
      price,
      size: ourPositionChange,
      spot: this.spot,
      time: Date.now()
    };
    
    this.model.onTrade(trade);
    
    return {
      customerSide,
      ourAction,
      strike,
      price,
      size,
      ourPositionChange,
      resultingPosition
    };
  }

  getInventory() {
    return this.model.getInventorySummary();
  }

  formatQuotes(strikes: number[], expiry: number = this.expiry) {
    console.log('\nStrike | Bid    | Ask    | Edge  | Size  | Mid Vol');
    console.log('---------------------------------------------------');
    
    for (const strike of strikes) {
      const q = this.getQuote(strike, expiry);
      const midPrice = (q.bid + q.ask) / 2;
      const midVol = Math.sqrt(midPrice / (this.spot * 0.4) / expiry) * 100;
      
      console.log(
        `${strike.toString().padStart(6)} | ` +
        `${q.bid.toFixed(2).padStart(6)} | ` +
        `${q.ask.toFixed(2).padStart(6)} | ` +
        `${q.edge.toFixed(2).padStart(5)} | ` +
        `${q.bidSize}/${q.askSize.toString().padEnd(3)} | ` +
        `${midVol.toFixed(1)}%`
      );
    }
  }
}