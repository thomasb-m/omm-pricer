import { QuoteExplainer } from './engine/QuoteExplainer';

const explanation = QuoteExplainer.explain(
  'BTC-50k-C',
  1000,
  1010,
  {
    theoRaw: 1000,
    theoInv: 995,
    skew: -5,
    spreadComponents: { fee: 0.10, noise: 0.05, model: 0.15, inventory: 0.02, total: 0.32 },
    bid: 994.68,
    ask: 995.32,
    sizeBid: 10,
    sizeAsk: 10,
    gLambdaG: 0.05,
    inventoryUtilization: 0.05,
  },
  0.01,
  {
    useModelSpread: true,
    useMicrostructure: true,
    useInventoryWidening: true,
    useInventorySkew: true,
  }
);

console.log(QuoteExplainer.formatForConsole(explanation, true));