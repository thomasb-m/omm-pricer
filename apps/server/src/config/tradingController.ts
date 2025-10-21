/**
 * Trading Controller - Manages Shadow vs Live Mode
 * 
 * Controls whether orders are actually sent to exchange or just logged
 */

export interface OrderToSend {
    instrumentId: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    type: 'limit' | 'market';
    postOnly?: boolean;
  }
  
  export interface ShadowFill {
    instrumentId: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    timestamp: number;
  }
  
  export class TradingController {
    private enableTrading: boolean;
    private tradeFraction: number;
    private orderCount: number = 0;
    
    constructor() {
      this.enableTrading = process.env.ENABLE_TRADING === 'true';
      this.tradeFraction = parseFloat(process.env.TRADE_FRACTION || '1.0');
      
      console.log('[TradingController] Initialized:', {
        enableTrading: this.enableTrading,
        tradeFraction: this.tradeFraction,
        mode: this.enableTrading 
          ? (this.tradeFraction < 1.0 ? `${(this.tradeFraction * 100).toFixed(0)}% live` : 'LIVE')
          : 'SHADOW'
      });
    }
    
    /**
     * Should this order actually be sent to exchange?
     */
    shouldSendOrder(): boolean {
      if (!this.enableTrading) {
        return false; // Shadow mode - never send
      }
      
      if (this.tradeFraction >= 1.0) {
        return true; // Full live mode - always send
      }
      
      // Trickle mode - send fraction of orders
      this.orderCount++;
      return (this.orderCount % Math.ceil(1 / this.tradeFraction)) === 0;
    }
    
    /**
     * Process order - either send to exchange or log as shadow
     */
    async processOrder(
      order: OrderToSend,
      exchangeSender: (order: OrderToSend) => Promise<any>
    ): Promise<{ sent: boolean; response?: any }> {
      
      if (this.shouldSendOrder()) {
        // LIVE MODE - actually send
        console.log('[LIVE] Sending order:', {
          instrument: order.instrumentId,
          side: order.side,
          price: order.price,
          size: order.size
        });
        
        try {
          const response = await exchangeSender(order);
          console.log('[LIVE] Order sent successfully:', response?.order_id);
          return { sent: true, response };
        } catch (err) {
          console.error('[LIVE] Order failed:', err);
          throw err;
        }
        
      } else {
        // SHADOW MODE - just log
        console.log('[SHADOW] Would send order:', {
          instrument: order.instrumentId,
          side: order.side,
          price: order.price,
          size: order.size
        });
        
        return { sent: false };
      }
    }
    
    /**
     * Simulate fill based on market data (for shadow mode)
     */
    simulateFill(
      order: OrderToSend,
      marketPrice: number,
      marketSize: number
    ): ShadowFill | null {
      
      // Check if market would have filled our order
      const wouldFill = 
        (order.side === 'buy' && marketPrice <= order.price) ||
        (order.side === 'sell' && marketPrice >= order.price);
      
      if (!wouldFill) {
        return null;
      }
      
      // Estimate fill size (conservative: 50% of market trade)
      const fillSize = Math.min(order.size, Math.floor(marketSize * 0.5));
      
      if (fillSize === 0) {
        return null;
      }
      
      const fill: ShadowFill = {
        instrumentId: order.instrumentId,
        side: order.side,
        price: order.price,
        size: fillSize,
        timestamp: Date.now()
      };
      
      console.log('[SHADOW] Simulated fill:', fill);
      
      return fill;
    }
    
    /**
     * Get current mode
     */
    getMode(): { mode: string; enableTrading: boolean; tradeFraction: number } {
      return {
        mode: this.enableTrading 
          ? (this.tradeFraction < 1.0 ? 'TRICKLE' : 'LIVE')
          : 'SHADOW',
        enableTrading: this.enableTrading,
        tradeFraction: this.tradeFraction
      };
    }
    
    /**
     * Runtime mode change (use carefully!)
     */
    setMode(enableTrading: boolean, tradeFraction: number = 1.0): void {
      this.enableTrading = enableTrading;
      this.tradeFraction = tradeFraction;
      console.log('[TradingController] Mode changed:', this.getMode());
    }
  }
  
  // Singleton instance
  let globalTradingController: TradingController | null = null;
  
  export function getTradingController(): TradingController {
    if (!globalTradingController) {
      globalTradingController = new TradingController();
    }
    return globalTradingController;
  }
  
  export function initTradingController(): TradingController {
    globalTradingController = new TradingController();
    return globalTradingController;
  }