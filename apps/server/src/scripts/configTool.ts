#!/usr/bin/env ts-node
/**
 * Config Tool - Manage Production Configurations
 * 
 * Usage:
 *   npx ts-node src/scripts/configTool.ts list
 *   npx ts-node src/scripts/configTool.ts show <config-name>
 *   npx ts-node src/scripts/configTool.ts profiles
 *   npx ts-node src/scripts/configTool.ts compare <config1> <config2>
 */

import { PRODUCTION_CONFIGS } from '../config/productionConfig';
import { STRATEGY_PROFILES } from '../config/strategyProfiles';

function listConfigs(): void {
  console.log('\n' + '='.repeat(70));
  console.log('AVAILABLE PRODUCTION CONFIGS');
  console.log('='.repeat(70));
  console.log();

  for (const [name, config] of Object.entries(PRODUCTION_CONFIGS)) {
    const indicator = process.env.TRADING_CONFIG === name ? '→' : ' ';
    console.log(`${indicator} ${name.padEnd(30)} ${config.environment.padEnd(12)} ${config.product}/${config.venue}`);
  }

  console.log();
  console.log('Current: ' + (process.env.TRADING_CONFIG || 'btc-deribit-testnet (default)'));
  console.log();
  console.log('To use: export TRADING_CONFIG=<config-name>');
  console.log('='.repeat(70) + '\n');
}

function showConfig(name: string): void {
  const config = PRODUCTION_CONFIGS[name];
  
  if (!config) {
    console.error(`❌ Config '${name}' not found`);
    console.log('\nAvailable configs:');
    Object.keys(PRODUCTION_CONFIGS).forEach(k => console.log(`  - ${k}`));
    process.exit(1);
  }

  console.log('\n' + '='.repeat(70));
  console.log(`CONFIG: ${name}`);
  console.log('='.repeat(70));
  console.log();

  console.log('📍 ENVIRONMENT');
  console.log(`  Environment:      ${config.environment}`);
  console.log(`  Product:          ${config.product}`);
  console.log(`  Venue:            ${config.venue}`);
  console.log();

  console.log('💰 PRICING');
  console.log(`  Tick:             ${config.tick}`);
  console.log(`  Maker Fee:        ${(config.makerFee * 10000).toFixed(2)} bps`);
  console.log(`  Taker Fee:        ${(config.takerFee * 10000).toFixed(2)} bps`);
  console.log();

  console.log('📊 PC DYNAMICS');
  console.log(`  Fill Anchor κ:    ${config.fillAnchorKappa}`);
  console.log(`  Fill Anchor γ:    ${config.fillAnchorGamma}`);
  console.log(`  Inventory Nudge:  ${config.inventoryNudgeAlpha}`);
  console.log();

  console.log('🎯 ALPHA');
  console.log(`  Enabled:          ${config.enableAlpha ? '✓' : '✗'}`);
  if (config.enableAlpha) {
    console.log(`  Alpha K:          ${config.alphaK}`);
    console.log(`  Max Clip (ticks): ${config.alphaMaxTicks}`);
  }
  console.log();

  console.log('🔒 LIMITS');
  console.log(`  Max Notional/min: ${config.maxNotionalPerMin} BTC`);
  console.log(`  Max Trades/min:   ${config.maxTradesPerMin}`);
  console.log(`  Max Position:     ${config.maxPositionNotional} BTC`);
  console.log(`  Max Inventory:    ${config.maxInventoryLots} lots`);
  console.log();

  console.log('🛡️  MMP (Market Maker Protection)');
  console.log(`  Enabled:          ${config.mmpEnabled ? '✓' : '✗'}`);
  if (config.mmpEnabled) {
    console.log(`  Qty Window:       ${config.mmpQtyWindow} lots`);
    console.log(`  Delta Window:     ${config.mmpDeltaWindow} BTC`);
    console.log(`  Vega Window:      ${config.mmpVegaWindow}`);
    console.log(`  Interval:         ${config.mmpInterval} ms`);
  }
  console.log(`  Post-Only Reject: ${config.postOnlyReject ? '✓' : '✗'}`);
  console.log(`  STP:              ${config.stpEnabled ? '✓' : '✗'}`);
  console.log(`  Cancel on DC:     ${config.cancelOnDisconnect ? '✓' : '✗'}`);
  console.log();

  console.log('🎯 DELTA-BAND DEFENSE');
  console.log(`  Enabled:          ${config.deltaBandEnabled ? '✓' : '✗'}`);
  if (config.deltaBandEnabled) {
    console.log(`  Threshold:        ${config.deltaBandThreshold}`);
    console.log(`  Window:           ${config.deltaBandWindow} ms`);
    console.log(`  Hold:             ${config.deltaBandHold} ms`);
    console.log(`  Grace:            ${config.deltaBandGrace} ms`);
  }
  console.log();

  console.log('📝 MONITORING');
  console.log(`  Log Level:        ${config.logLevel}`);
  console.log(`  Metrics Interval: ${config.metricsIntervalMs} ms`);
  console.log(`  Diagnostics:      ${config.enableDiagnostics ? '✓' : '✗'}`);
  console.log();

  console.log('='.repeat(70) + '\n');
}

function listProfiles(): void {
  console.log('\n' + '='.repeat(70));
  console.log('STRATEGY PROFILES');
  console.log('='.repeat(70));
  console.log();

  for (const [name, profile] of Object.entries(STRATEGY_PROFILES)) {
    console.log(`📋 ${profile.name.toUpperCase()}`);
    console.log(`   Clip:           ${profile.clip} lots @ ${profile.halfSpread * 10000} bps spread`);
    console.log(`   Display:        ${profile.minDisplay}-${profile.maxVisible} lots`);
    console.log(`   Reserve:        ${profile.reserveFactor}x`);
    console.log(`   Snapper:        ${profile.policy} (step: ${(profile.stepFrac * 100).toFixed(0)}%, cooldown: ${profile.cooldownMs}ms)`);
    console.log(`   PC Gravity:     α=${profile.pcGravityAlpha}`);
    console.log(`   Max Notional:   ${profile.maxNotional} BTC`);
    console.log(`   Max Delta:      ±${profile.maxDeltaPerSide} BTC`);
    console.log();
  }

  console.log('='.repeat(70) + '\n');
}

function compareConfigs(name1: string, name2: string): void {
  const config1 = PRODUCTION_CONFIGS[name1];
  const config2 = PRODUCTION_CONFIGS[name2];

  if (!config1 || !config2) {
    console.error(`❌ One or both configs not found`);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(70));
  console.log(`COMPARE: ${name1} vs ${name2}`);
  console.log('='.repeat(70));
  console.log();

  const fields: Array<[string, keyof typeof config1]> = [
    ['Environment', 'environment'],
    ['Enable Alpha', 'enableAlpha'],
    ['Alpha K', 'alphaK'],
    ['Alpha Max Ticks', 'alphaMaxTicks'],
    ['PC Gravity', 'inventoryNudgeAlpha'],
    ['Max Notional/min', 'maxNotionalPerMin'],
    ['Max Trades/min', 'maxTradesPerMin'],
    ['Max Position', 'maxPositionNotional'],
    ['MMP Enabled', 'mmpEnabled'],
    ['MMP Qty Window', 'mmpQtyWindow'],
    ['Delta Band', 'deltaBandEnabled'],
    ['Log Level', 'logLevel'],
    ['Diagnostics', 'enableDiagnostics']
  ];

  console.log('Parameter'.padEnd(25) + name1.padEnd(25) + name2);
  console.log('-'.repeat(70));

  for (const [label, key] of fields) {
    const val1 = String(config1[key]);
    const val2 = String(config2[key]);
    const diff = val1 !== val2 ? ' ⚠️' : '';
    console.log(label.padEnd(25) + val1.padEnd(25) + val2 + diff);
  }

  console.log();
  console.log('='.repeat(70) + '\n');
}

// Main CLI
if (require.main === module) {
  const [,, command, ...args] = process.argv;

  switch (command) {
    case 'list':
      listConfigs();
      break;

    case 'show':
      if (!args[0]) {
        console.error('Usage: configTool show <config-name>');
        process.exit(1);
      }
      showConfig(args[0]);
      break;

    case 'profiles':
      listProfiles();
      break;

    case 'compare':
      if (args.length < 2) {
        console.error('Usage: configTool compare <config1> <config2>');
        process.exit(1);
      }
      compareConfigs(args[0], args[1]);
      break;

    default:
      console.log('\nConfig Tool - Manage Production Configurations\n');
      console.log('Commands:');
      console.log('  list                      List all available configs');
      console.log('  show <config-name>        Show detailed config');
      console.log('  profiles                  List strategy profiles');
      console.log('  compare <c1> <c2>         Compare two configs');
      console.log('\nExamples:');
      console.log('  npx ts-node src/scripts/configTool.ts list');
      console.log('  npx ts-node src/scripts/configTool.ts show btc-deribit-testnet');
      console.log('  npx ts-node src/scripts/configTool.ts profiles');
      console.log('  npx ts-node src/scripts/configTool.ts compare btc-deribit-testnet btc-deribit-production\n');
      break;
  }
}