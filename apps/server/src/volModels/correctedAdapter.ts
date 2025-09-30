/**
 * Corrected Adapter with Proper Trade Side Logic
 * 
 * CRITICAL FIX: Trade sides now work correctly:
 * - Customer BUYS from us (lifts offer) -> We're SHORT -> Raise vols
 * - Customer SELLS to us (hits bid) -> We're LONG -> Lower vols
 */

import { IntegratedSmileModel, TradeExecution } from './integratedSmileModel';
import { TraderMetrics } from './dualSurfaceModel';

export type CustomerSide = 'BUY' | 'SELL';  // What the customer does
export type MarketMakerPosition = 'LONG' | 'SHORT';  // Our resulting position

export class CorrectedAdapter {
  private model: IntegratedSmileModel;
  private spot: number;
  private expiry: number = 0.08; // 30 days
  private debug: boolean = false;

  constructor(spot: number, debug: boolean = false) {
    this.spot = spot;
    this.debug = debug;
    this.model = new IntegratedSmileModel('BTC');
    
    // Initialize CC (Core Curve)
    const initialMetrics: TraderMetrics = {
      L0: 0.04,    // 20% vol
      S0: 0.001,
      C0: 0.5,
      S_neg: -0.8,
      S_pos: 0.9
    };
    
    this.model.updateCC(this.expiry, initialMetrics);
    
    if (this.debug) {
      console.log('Model initialized with 20% ATM vol');
    }
  }

  getQuote(strike: number, expiry: number = this.expiry) {
    return this.model.getQuote(expiry, strike, this.spot);
  }

  /**
   * Execute a customer trade
   * @param strike - Strike price
   * @param expiry - Time to expiry
   * @param customerSide - What the CUSTOMER is doing (BUY or SELL)
   * @param size - Trade size (always positive)
   * @param price - Execution price (optional, uses quote if not provided)
   */
  executeCustomerTrade(
    strike: number, 
    expiry: number = this.expiry,
    customerSide: CustomerSide,
    size: number,
    price?: number
  ) {
    // Get quote if no price specified
    if (!price) {
      const quote = this.getQuote(strike, expiry);
      price = customerSide === 'BUY' ? quote.ask : quote.bid;
    }

    // CRITICAL: Determine our position change
    // Customer BUYS -> We SELL -> Our position goes DOWN (negative)
    // Customer SELLS -> We BUY -> Our position goes UP (positive)
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

    // Create trade execution object
    const trade: TradeExecution = {
      expiry,
      strike,
      price,
      size: ourPositionChange,  // Our position change (negative if we sold)
      spot: this.spot,
      time: Date.now()
    };
    
    // Execute via onTrade
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
      // Approximate mid vol from price (simplified)
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

// Test the corrected logic
function testCorrectedLogic() {
  console.log('\n' + '='.repeat(60));
  console.log('TESTING CORRECTED TRADE LOGIC');
  console.log('='.repeat(60));
  
  const model = new CorrectedAdapter(100, true);  // Enable debug
  
  console.log('\n1️⃣ INITIAL STATE');
  model.formatQuotes([95, 100, 105]);
  
  // Test 1: Customer SELLS puts to us (hits our bid)
  console.log('\n' + '-'.repeat(60));
  console.log('2️⃣ CUSTOMER SELLS 100x 95 PUTS (hits our bid)');
  console.log('   They are selling protection to us');
  
  const trade1 = model.executeCustomerTrade(95, 0.08, 'SELL', 100);
  
  console.log('\nAfter customer SOLD to us:');
  model.formatQuotes([95, 100, 105]);
  
  const inv1 = model.getInventory();
  console.log(`\nInventory: ${inv1.totalVega.toFixed(1)} vega`);
  console.log(`Level adjustment: ${(inv1.smileAdjustments.deltaL0 * 100).toFixed(2)}%`);
  
  if (inv1.totalVega > 0) {
    console.log(`✅ CORRECT: We're LONG vega (bought puts)`);
    if (inv1.smileAdjustments.deltaL0 < 0) {
      console.log(`✅ CORRECT: Vols decreased`);
    } else {
      console.log(`❌ ERROR: Vols should have decreased!`);
    }
  } else {
    console.log(`❌ ERROR: We should be LONG vega after buying!`);
  }
  
  // Test 2: Customer BUYS puts from us (lifts our offer)
  console.log('\n' + '-'.repeat(60));
  console.log('3️⃣ CUSTOMER BUYS 150x 100 PUTS (lifts our offer)');
  console.log('   They are buying protection from us');
  
  const trade2 = model.executeCustomerTrade(100, 0.08, 'BUY', 150);
  
  console.log('\nAfter customer BOUGHT from us:');
  model.formatQuotes([95, 100, 105]);
  
  const inv2 = model.getInventory();
  console.log(`\nInventory: ${inv2.totalVega.toFixed(1)} vega`);
  console.log(`Level adjustment: ${(inv2.smileAdjustments.deltaL0 * 100).toFixed(2)}%`);
  
  if (inv2.totalVega < inv1.totalVega) {
    console.log(`✅ CORRECT: Vega decreased (we sold puts)`);
    if (inv2.smileAdjustments.deltaL0 > inv1.smileAdjustments.deltaL0) {
      console.log(`✅ CORRECT: Vols increased`);
    } else {
      console.log(`❌ ERROR: Vols should have increased!`);
    }
  } else {
    console.log(`❌ ERROR: Vega should decrease after selling!`);
  }
  
  // Show final state
  console.log('\n' + '-'.repeat(60));
  console.log('4️⃣ FINAL SUMMARY');
  console.log('\nFinal position breakdown:');
  console.log(`  From customer selling: +${trade1.size} (we bought)`);
  console.log(`  From customer buying:  -${trade2.size} (we sold)`);
  console.log(`  Net position: ${inv2.totalVega > 0 ? 'LONG' : 'SHORT'} ${Math.abs(inv2.totalVega).toFixed(1)} vega`);
  
  console.log('\n' + '='.repeat(60));
  console.log('TEST COMPLETE');
  console.log('='.repeat(60));
}

// Run test
testCorrectedLogic();