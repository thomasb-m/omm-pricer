import fs from "fs";
import path from "path";

const LOG_DIR = path.resolve("data");
const LOG_FILE = path.join(LOG_DIR, "trades.jsonl");

export type TradeRow = {
  ts: number;
  symbol: string;
  F: number;
  K: number;
  expiryMs: number;
  side: "BUY" | "SELL";
  qty: number;
  ccMid: number;
  pcMid: number;
  tradePx: number;
  dotLamG?: number;
  I_before?: number[];
  I_after?: number[];
  lambda?: number[];
  pnl_est: number;
  signal_tags?: string[];
};

export class TradeLog {
  static write(row: TradeRow) {
    // Create directory if it doesn't exist
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    
    // Append trade as JSON line
    fs.appendFileSync(LOG_FILE, JSON.stringify(row) + "\n");
  }
  
  static clear() {
    if (fs.existsSync(LOG_FILE)) {
      fs.unlinkSync(LOG_FILE);
    }
  }
}
