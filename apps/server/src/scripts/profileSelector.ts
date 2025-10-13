#!/usr/bin/env ts-node
/**
 * Profile Selector - Test Profile Selection Logic
 * 
 * Usage:
 *   npx ts-node src/scripts/profileSelector.ts <strike> <forward> <T> <iv>
 */

import { selectProfile } from '../config/strategyProfiles';

function testProfile(strike: number, forward: number, T: number, iv: number, rvZ: number = 0): void {
  const profile = selectProfile({ strike, forward, T, iv, rvZ });

  const moneyness = strike / forward;
  const daysToExpiry = T * 365;

  console.log('\n' + '='.repeat(70));
  console.log('PROFILE SELECTION TEST');
  console.log('='.repeat(70));
  console.log();

  console.log('📊 INSTRUMENT');
  console.log(`  Strike:          $${strike.toLocaleString()}`);
  console.log(`  Forward:         $${forward.toLocaleString()}`);
  console.log(`  Moneyness:       ${(moneyness * 100).toFixed(2)}%`);
  console.log(`  Time to Expiry:  ${daysToExpiry.toFixed(1)} days (${T.toFixed(4)} years)`);
  console.log(`  IV:              ${(iv * 100).toFixed(1)}%`);
  console.log(`  RV Z-score:      ${rvZ.toFixed(2)}`);
  console.log();

  console.log('🎯 SELECTED PROFILE: ' + profile.name.toUpperCase());
  console.log('─'.repeat(70));
  console.log(`  Clip Size:       ${profile.clip} lots`);
  console.log(`  Half Spread:     ${(profile.halfSpread * 10000).toFixed(1)} bps`);
  console.log(`  Display Range:   ${profile.minDisplay}-${profile.maxVisible} lots`);
  console.log(`  Reserve Factor:  ${profile.reserveFactor}x`);
  console.log(`  Snapper Policy:  ${profile.policy}`);
  console.log(`  Step Fraction:   ${(profile.stepFrac * 100).toFixed(0)}%`);
  console.log(`  Edge Min:        ${profile.edgeStepMinTicks} ticks`);
  console.log(`  Cooldown:        ${profile.cooldownMs} ms`);
  console.log(`  PC Gravity:      α=${profile.pcGravityAlpha}`);
  console.log(`  Max Notional:    ${profile.maxNotional} BTC`);
  console.log(`  Max Delta:       ±${profile.maxDeltaPerSide} BTC`);
  console.log();

  console.log('💡 REASONING');
  if (moneyness < 0.85 || moneyness > 1.15) {
    console.log('  → Far OTM detected');
  }
  if (T < 0.02) {
    console.log('  → Short-dated (< 7 days)');
  }
  if (rvZ > 2.0) {
    console.log('  → High volatility (stress mode)');
  }
  if (profile.name === 'default') {
    console.log('  → Near-money or standard conditions');
  }
  console.log();

  console.log('='.repeat(70) + '\n');
}

function runExamples(): void {
  console.log('\n' + '='.repeat(70));
  console.log('EXAMPLE INSTRUMENTS');
  console.log('='.repeat(70));

  const examples = [
    { label: 'ATM 30d', strike: 100000, forward: 100000, T: 30/365, iv: 0.65 },
    { label: '10% OTM 90d', strike: 110000, forward: 100000, T: 90/365, iv: 0.70 },
    { label: '20% OTM 180d', strike: 120000, forward: 100000, T: 180/365, iv: 0.75 },
    { label: 'ATM 3d', strike: 100000, forward: 100000, T: 3/365, iv: 0.60 },
    { label: 'ATM Stress', strike: 100000, forward: 100000, T: 30/365, iv: 0.90, rvZ: 3.0 }
  ];

  console.log();
  console.log('Strike'.padEnd(12) + 'Forward'.padEnd(12) + 'Days'.padEnd(8) + 'IV'.padEnd(8) + 'RV Z'.padEnd(8) + 'Profile');
  console.log('-'.repeat(70));

  for (const ex of examples) {
    const profile = selectProfile({ 
      strike: ex.strike, 
      forward: ex.forward, 
      T: ex.T, 
      iv: ex.iv,
      rvZ: ex.rvZ || 0
    });
    
    console.log(
      `$${(ex.strike/1000).toFixed(0)}k`.padEnd(12) +
      `$${(ex.forward/1000).toFixed(0)}k`.padEnd(12) +
      `${(ex.T * 365).toFixed(0)}d`.padEnd(8) +
      `${(ex.iv * 100).toFixed(0)}%`.padEnd(8) +
      `${(ex.rvZ || 0).toFixed(1)}`.padEnd(8) +
      profile.name
    );
  }

  console.log();
  console.log('='.repeat(70) + '\n');
}

// Main CLI
if (require.main === module) {
  const [,, ...args] = process.argv;

  if (args.length === 0 || args[0] === 'examples') {
    runExamples();
  } else if (args.length >= 4) {
    const strike = parseFloat(args[0]);
    const forward = parseFloat(args[1]);
    const T = parseFloat(args[2]);
    const iv = parseFloat(args[3]);
    const rvZ = args[4] ? parseFloat(args[4]) : 0;

    if (isNaN(strike) || isNaN(forward) || isNaN(T) || isNaN(iv)) {
      console.error('❌ Invalid arguments');
      console.log('\nUsage: profileSelector <strike> <forward> <T> <iv> [rvZ]');
      console.log('Example: profileSelector 110000 100000 0.0822 0.65 0');
      process.exit(1);
    }

    testProfile(strike, forward, T, iv, rvZ);
  } else {
    console.log('\nProfile Selector - Test Profile Selection Logic\n');
    console.log('Usage:');
    console.log('  profileSelector examples                       Show example instruments');
    console.log('  profileSelector <strike> <forward> <T> <iv>    Test specific instrument');
    console.log('\nExample:');
    console.log('  npx ts-node src/scripts/profileSelector.ts 110000 100000 0.0822 0.65\n');
  }
}