// Create new file: apps/server/src/volModels/integration/volModelService.ts

import { CorrectedAdapter } from '../correctedAdapter';

interface ProductConfig {
  symbol: string;
  initialSpot: number;
  defaultExpiry: number;
}

export class VolModelService {
  private models: Map<string, CorrectedAdapter> = new Map();
  private spots: Map<string, number> = new Map();
  
  constructor(products: ProductConfig[]) {
    products.forEach(p => {
      this.models.set(p.symbol, new CorrectedAdapter(p.initialSpot));
      this.spots.set(p.symbol, p.initialSpot);
      console.log(`Initialized vol model for ${p.symbol} at ${p.initialSpot}`);
    });
  }
  
  // Get quote from model
  getQuote(symbol: string, strike: number, expiry: number = 0.08) {
    const model = this.models.get(symbol);
    if (!model) {
      throw new Error(`No model for ${symbol}`);
    }
    return model.getQuote(strike, expiry);
  }
  
  // Process customer trade
  onCustomerTrade(
    symbol: string,
    strike: number,
    customerSide: 'BUY' | 'SELL',
    size: number,
    price: number,
    expiry: number = 0.08
  ) {
    const model = this.models.get(symbol);
    if (!model) return null;
    
    return model.executeCustomerTrade(strike, expiry, customerSide, size, price);
  }
  
  // Update spot price (really forward for our purposes)
  updateSpot(symbol: string, newSpot: number) {
    const oldSpot = this.spots.get(symbol);
    this.spots.set(symbol, newSpot);
    console.log(`${symbol} forward: ${oldSpot} -> ${newSpot}`);
  }
  
  // Get current inventory
  getInventory(symbol: string) {
    const model = this.models.get(symbol);
    if (!model) return null;
    return model.getInventory();
  }
}

// Create singleton instance
export const volService = new VolModelService([
  { symbol: 'BTC', initialSpot: 45000, defaultExpiry: 0.08 },
  { symbol: 'ETH', initialSpot: 3000, defaultExpiry: 0.08 }
]);