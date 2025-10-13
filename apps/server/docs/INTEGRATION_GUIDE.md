# 🔧 Integration Guide - Config System + ISM

## Overview

This guide shows how to wire the production config system into your existing IntegratedSmileModel.

## Architecture

ConfigManager is a singleton that provides:
- ProductionConfig: fees, limits, PC dynamics
- StrategyProfiles: per-instrument behavior

These feed into IntegratedSmileModel which drives Target Curve Pricing.

---

## Step 1: Initialize Config Manager

In your main server startup file (apps/server/src/server.ts or main.ts):

Add imports:
- import { initConfigManager, getConfigManager } from './config/configManager'
- import { loadConfigFromEnv } from './config/productionConfig'

Load config from environment:
- const prodConfig = loadConfigFromEnv()
- Log: Loading config from TRADING_CONFIG env var (default: btc-deribit-testnet)

Initialize singleton:
- const configManager = initConfigManager(prodConfig)
- console.log(configManager.getSummary())

---

## Step 2: Wire into ISM Constructor

Modify: apps/server/src/volModels/integratedSmileModel.ts

Add to imports:
- import { getConfigManager } from '../config/configManager'
- import type { StrategyProfile } from '../config/strategyProfiles'

Add to class fields:
- private configManager = getConfigManager()
- private activeProfile?: StrategyProfile

In constructor, add:
- const prodConfig = this.configManager.getProductionConfig()
- this.useVarianceBump = process.env.USE_VARIANCE_BUMP === 'true'
- Log initialization with environment, enableAlpha, mmpEnabled
---

## Step 3: Get Profile Per Quote

In the getQuote() method of IntegratedSmileModel:

At the start of the method, after computing T:
- Create instrumentId string: symbol-expiryMs-strike-optionType
- Call configManager.getStrategyProfile with params:
  - instrumentId
  - strike
  - forward
  - T
  - iv (use marketIV or default 0.65)
  - rvZ (set to 0 for now, compute from recent data later)

Store the result:
- this.activeProfile = profile

Use profile parameters instead of hardcoded values:
- const policySize = profile.clip
- const halfSpread = profile.halfSpread
- const pcGravityAlpha = profile.pcGravityAlpha

This replaces any hardcoded values like policySize=100, halfSpread=0.0001

---

## Step 4: Use Production Config for Fees and Limits

In your order execution logic:

Get production config:
- const prodConfig = getConfigManager().getProductionConfig()

Check limits before executing:
- if (order.notional > prodConfig.maxNotionalPerMin) reject
- if (tradesThisMinute > prodConfig.maxTradesPerMin) reject

Apply fees based on order side:
- const fee = order.side === 'buy' ? prodConfig.takerFee : prodConfig.makerFee
- order.expectedFee = order.price * order.size * Math.abs(fee)

Set Deribit order flags:
- order.postOnly = prodConfig.postOnlyReject
- order.mmp = prodConfig.mmpEnabled
- order.reduceOnly = false (or based on your logic)

---

## Step 5: MMP Configuration

When connecting to Deribit API:

Check if MMP is enabled:
- const prodConfig = getConfigManager().getProductionConfig()
- if (!prodConfig.mmpEnabled) skip MMP setup

Configure MMP with production values:
- currency: 'BTC'
- interval: prodConfig.mmpInterval
- frozen_time: 1000 ms
- quantity_limit: prodConfig.mmpQtyWindow
- delta_limit: prodConfig.mmpDeltaWindow
- vega_limit: prodConfig.mmpVegaWindow (if supported)

Call Deribit API:
- await deribitClient.setMMP(mmpConfig)
- Log the configuration for verification
---

## Step 6: Runtime Profile Switching

For operational control during live trading:

Force specific profile for an instrument:
- configManager.setProfileForInstrument(instrumentId, profileName)
- Example: Switch BTC-1760688000000-111000-C to stress mode
- Log the change for audit trail

Via API endpoint (if you add one):
- POST /api/config/profile/:instrumentId
- Body: { profileName: 'stress' }
- Returns: { success: true, profile: 'stress' }

This allows ops team to override auto-selection without restart.

---

## Step 7: Environment Variable Control

Key environment variables for runtime control:

Config selection:
- TRADING_CONFIG: btc-deribit-production, btc-deribit-testnet, etc

Feature flags:
- USE_VARIANCE_BUMP: true/false (enable target curve pricing)
- ENABLE_TRADING: false for shadow mode
- ENABLE_ALPHA: true/false (override config)

Runtime overrides:
- FORCE_PROFILE: stress, default, otm_fly
- FORCE_CLIP: 5, 10, 1000 (override clip size)
- PC_GRAVITY_ALPHA: 0.05, 0.1, 0.15
- SNAPPER_POLICY: join, smart

These provide emergency controls without code changes.

---

## Testing Integration

### Test 1: Config Loading

Run: npx ts-node apps/server/src/scripts/configTool.ts show btc-deribit-testnet

Verify:
- Config loads without errors
- All parameters display correctly
- Environment matches expectation

### Test 2: Profile Selection

Run: npx ts-node apps/server/src/scripts/profileSelector.ts 110000 100000 0.0822 0.65

Verify:
- Correct profile selected (default for near-money)
- Parameters match expectations
- Reasoning logged correctly

### Test 3: Run with Config

Set environment and run test:
- export TRADING_CONFIG=btc-deribit-testnet
- export USE_VARIANCE_BUMP=true
- npx ts-node apps/server/src/scripts/testTradeExecution.ts

Verify:
- System loads correct config
- Quotes use profile parameters
- No errors in initialization

### Test 4: Check Runtime Config

In your application code:
- const cm = getConfigManager()
- console.log(cm.getSummary())
- console.log(cm.getActiveProfiles())

Verify:
- Correct config active
- Profiles cached properly
- Changes reflected immediately
---

## Migration Plan

### Current State (Before Integration)

Old hardcoded approach:
- const policySize = 100
- const halfSpread = 0.0001
- const pcGravityAlpha = 0.1
- Values scattered throughout code
- No runtime control
- No profile differentiation

### New State (After Integration)

New config-driven approach:
- const profile = configManager.getStrategyProfile({ params })
- const policySize = profile.clip
- const halfSpread = profile.halfSpread
- const pcGravityAlpha = profile.pcGravityAlpha
- Centralized configuration
- Runtime control via env vars
- Automatic profile selection

### Gradual Migration Steps

Step 1: Add config system
- Create config files (DONE)
- Create CLI tools (DONE)
- No code changes yet

Step 2: Wire into ISM
- Add configManager to ISM
- Keep old values as fallback
- Log both old and new values
- Verify they match in test

Step 3: Switch to config values
- Use profile.clip instead of hardcoded
- Use profile.halfSpread instead of hardcoded
- Remove old hardcoded values
- Test thoroughly

Step 4: Test in shadow mode
- Run with ENABLE_TRADING=false
- Verify quote behavior
- Check all profiles work
- Monitor for 48 hours

Step 5: Deploy to testnet
- Use btc-deribit-testnet config
- Small position limits
- Enable all features
- Run for 1 week

Step 6: Go live
- Switch to btc-deribit-production
- Follow go-live checklist
- Gradual rollout (5% -> 20% -> 100%)

---

## Best Practices

### DO ✅

- Use getConfigManager() singleton everywhere
- Load config once at startup, cache it
- Cache profiles per instrument
- Override via env vars for emergencies only
- Log all config changes with timestamps
- Test profile selection logic thoroughly
- Document all overrides in runbook
- Review configs weekly

### DON'T ❌

- Hardcode parameters in pricing logic
- Create multiple ConfigManager instances
- Change config during active trading (use overrides)
- Skip validation of environment overrides
- Deploy without testing config loading
- Override configs without logging
- Use production config in test environments
- Commit secrets or API keys to config files

---

## Troubleshooting

### Config not loading

Check environment variable:
- echo $TRADING_CONFIG
- Should return config name or empty (uses default)

Verify file exists:
- ls apps/server/src/config/productionConfig.ts
- Should list the file

Test direct loading:
- node -e "console.log(require('./dist/config/productionConfig').loadConfigFromEnv())"
- Should print config object

### Wrong profile selected

Debug selection logic:
- npx ts-node apps/server/src/scripts/profileSelector.ts [strike] [forward] [T] [iv]
- Check reasoning output

Force override:
- export FORCE_PROFILE=default
- Restart application
- Verify override in logs

### Parameters not applying

Check active config via API:
- curl http://localhost:3000/api/config/status
- Should return current config

Check logs for config initialization:
- grep "ISM] Initialized with config" logs/app.log
- Should show config being loaded

Restart with explicit config:
- export TRADING_CONFIG=btc-deribit-testnet
- npm restart
- Verify in startup logs

Clear profile cache:
- configManager.clearProfileCache()
- Forces re-selection on next quote

---

## Next Steps

1. Complete ISM integration using examples above
2. Add API endpoints for runtime control
3. Create monitoring dashboard showing active config/profiles
4. Run shadow mode for 48 hours on testnet
5. Deploy to testnet with tight limits
6. Follow go-live checklist for production deployment
7. Monitor KPIs and tune parameters weekly

---

## Document Info

- Version: 1.0
- Last Updated: October 13, 2025
- Owner: Trading Technology Team
- Review Cycle: After each major config change
- Related Docs: GO_LIVE_CHECKLIST.md, API_REFERENCE.md