"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVolQuote = getVolQuote;
const correctedAdapter_1 = require("../correctedAdapter");
// Start with just BTC to test
const btcModel = new correctedAdapter_1.CorrectedAdapter(100); // Initialize with spot price
// Simple function to get a quote
function getVolQuote(strike) {
    return btcModel.getQuote(strike);
}
// Test it works
console.log('Test quote for strike 95:', getVolQuote(95));
