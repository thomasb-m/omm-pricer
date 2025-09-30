/**
 * Simple test runner
 * Run with: npx ts-node apps/server/src/volModels/runTests.ts
 */

import { runAllTests } from './tests/testDualSurface';

console.log('Starting Dual Surface Model Tests...\n');
runAllTests();