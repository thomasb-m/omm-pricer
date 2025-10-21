"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timeToExpiryYears = timeToExpiryYears;
function timeToExpiryYears(expiryMs, now = Date.now()) {
    const msInYear = 365 * 24 * 60 * 60 * 1000;
    return Math.max((expiryMs - now) / msInYear, 0);
}
