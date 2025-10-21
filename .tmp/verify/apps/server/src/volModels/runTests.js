"use strict";
/**
 * Simple test runner
 * Run with: npx ts-node apps/server/src/volModels/runTests.ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
const testDualSurface_1 = require("./tests/testDualSurface");
console.log('Starting Dual Surface Model Tests...\n');
(0, testDualSurface_1.runAllTests)();
