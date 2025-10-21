# 🚀 Go-Live Checklist - Target Curve Pricing

## Pre-Launch (1 Week Before)

### Infrastructure
- [ ] Deribit API credentials configured (testnet + production)
- [ ] MMP settings reviewed and approved by risk
- [ ] Cancel-on-disconnect enabled
- [ ] Self-trade prevention enabled
- [ ] Rate limits configured and tested
- [ ] Monitoring/alerting set up (PagerDuty/Slack)
- [ ] Backup systems tested (failover, reconnect logic)

### Configuration
- [ ] Production config reviewed: `btc-deribit-production`
- [ ] Strategy profiles defined for target instruments
- [ ] Risk limits set and verified
  - [ ] Max notional per minute: 50 BTC
  - [ ] Max trades per minute: 100
  - [ ] Max position: 500 BTC
  - [ ] Max inventory: 10,000 lots
- [ ] Fee assumptions verified (maker: -0.03%, taker: 0.03%)
- [ ] Delta-band pickoff defense configured
- [ ] Lambda/Sigma calibrated for target instruments

### Testing
- [ ] Backtests run on 3+ months historical data
- [ ] Shadow mode run for 48+ hours (testnet)
- [ ] All gold tests passing (9/9)
- [ ] Parameter sweep validated optimal settings
- [ ] Edge case testing complete:
  - [ ] Network disconnects
  - [ ] Order rejections
  - [ ] MMP triggers
  - [ ] Fast market moves
  - [ ] Thin liquidity
- [ ] Stress test with high message rates

### Team Readiness
- [ ] Trading desk briefed on system behavior
- [ ] Risk team understands target curve mechanics
- [ ] Operations trained on CLI tools
- [ ] Runbook prepared for common issues
- [ ] Emergency contacts list updated
- [ ] Kill-switch procedure documented and tested
---

## Launch Day

### Phase 1: Shadow Mode (Hours 0-2)

Start with trading disabled:
- TRADING_CONFIG=btc-deribit-production
- ENABLE_TRADING=false

**Monitor:**
- [ ] Quotes generating correctly (10x10 ladder)
- [ ] PC anchoring on simulated fills
- [ ] Tracking error < 5 lots median
- [ ] No errors in logs
- [ ] Latency < 50ms p99

**Checklist:**
- [ ] All instruments quoting
- [ ] No crossed markets
- [ ] Spreads match config (1 tick)
- [ ] Sizes match profiles (default: 10, otm_fly: 1000)

### Phase 2: Trickle Live (Hours 2-4)

Enable 5% of quotes:
- ENABLE_TRADING=true
- TRADE_FRACTION=0.05

**Start with:**
- [ ] 1-2 ATM strikes only
- [ ] Single tenor (7d or 30d)
- [ ] Calls only (skip puts initially)

**Monitor:**
- [ ] First fill observed and PC anchored correctly
- [ ] No adverse selection (fill edge ≥ -0.5 bps)
- [ ] Inventory tracking working
- [ ] MMP not triggering
- [ ] P&L attribution correct

**Success Criteria (2 hours):**
- [ ] 5+ fills executed
- [ ] Tracking error < 10 lots
- [ ] Fill edge > -1 bps
- [ ] Zero MMP/STP triggers
- [ ] Position within limits

### Phase 3: Scale to 20% (Hours 4-8)

Increase to TRADE_FRACTION=0.20

**Add:**
- [ ] ±1 strike on either side of ATM
- [ ] Both calls and puts
- [ ] Keep single tenor

**Monitor:**
- [ ] Participation rate 5-15%
- [ ] Balanced fills (buy ≈ sell within 20%)
- [ ] Net position stable (< 50 lots)
- [ ] Queue presence maintained
- [ ] Snapper working (join vs step-ahead)

**Success Criteria (4 hours):**
- [ ] 50+ fills executed
- [ ] Median tracking error < 5 lots
- [ ] Avg fill edge > -0.5 bps
- [ ] No operational issues

### Phase 4: Full Launch (Hours 8+)

Set TRADE_FRACTION=1.0

**Add:**
- [ ] Multiple tenors (7d, 14d, 30d)
- [ ] Full strike range (0.8-1.2 moneyness)
- [ ] Enable CC micro-alpha (if tested)

**Monitor:**
- [ ] Participation 10-20% across strikes
- [ ] Factor inventory balanced
- [ ] P&L positive after fees
- [ ] No runaway positions
- [ ] All profiles working (default, otm_fly)
---

## Post-Launch (First Week)

### Daily Review
- [ ] P&L analysis by path (maker vs taker)
- [ ] Fill quality metrics (edge, participation)
- [ ] Tracking error distribution
- [ ] Inventory turnover
- [ ] Queue position analysis
- [ ] Snapper effectiveness (join vs step rate)

### Weekly Review
- [ ] Parameter optimization (rScale, lambda)
- [ ] Profile tuning (clip sizes, spreads)
- [ ] Risk limit adjustments
- [ ] Add new instruments gradually

### Phase 2 Features (Week 2+)
- [ ] Enable CC micro-alpha (if disabled)
- [ ] Enable smart step-ahead (if on join-only)
- [ ] Add taker module (aggressive lifts)
- [ ] Expand to ETH/SOL

---

## Emergency Procedures

### Kill Switch (Immediate Stop)

Stop all trading immediately using npm run kill-switch or POST to /api/emergency/stop

### Partial Shutdown

Options:
- Disable specific instruments
- Disable entire tenor
- Switch to stress mode: FORCE_PROFILE=stress

### Common Issues

**High tracking error (>20 lots)**
- Check inventory with npm run check-inventory
- Reduce clip size: FORCE_CLIP=5
- Increase PC gravity: PC_GRAVITY_ALPHA=0.2

**Negative fill edge**
- Enable alpha nudge: ENABLE_ALPHA=true
- Widen spread: FORCE_SPREAD=0.0002
- Switch to join-only: SNAPPER_POLICY=join

**MMP triggering**
- Check status: npm run show-mmp-status
- Increase windows: MMP_QTY_WINDOW=2000, MMP_DELTA_WINDOW=200
- Slow down quoting: QUOTE_COOLDOWN_MS=200
---

## KPIs to Monitor

### Real-Time (< 1 min delay)
- Active quotes count
- Fill rate (fills/min)
- Net position (lots)
- P&L (BTC)
- MMP triggers
- Error rate

### Hourly
- Participation rate by strike
- Fill edge distribution
- Tracking error (median, 95th)
- Queue share vs realized fills
- Snapper actions (join/step/back_off)

### Daily
- Total P&L by path
- Inventory turnover
- Profile effectiveness
- Risk utilization
- Operational incidents

---

## Success Metrics (First Month)

### Must Achieve
- [ ] Zero downtime incidents
- [ ] Zero risk limit breaches
- [ ] Positive P&L after fees
- [ ] Tracking error < 10 lots (median)
- [ ] Fill edge > -0.5 bps (average)

### Target
- [ ] 10-15% participation rate
- [ ] Tracking error < 5 lots (median)
- [ ] Fill edge > 0 bps (break-even to positive)
- [ ] 95%+ uptime
- [ ] < 5 operational issues per week

### Stretch
- [ ] 15-20% participation
- [ ] Fill edge > +0.2 bps (profitable alpha)
- [ ] Tracking error < 3 lots
- [ ] Sub-second quote latency p99
- [ ] Zero manual interventions needed

---

## Contacts

**Trading Desk:** [phone/slack]
**Risk Management:** [phone/slack]
**Engineering On-Call:** [pagerduty]
**Deribit Support:** support@deribit.com

---

## Document Info

- **Version:** 1.0
- **Last Updated:** October 13, 2025
- **Owner:** Trading Technology Team
- **Review Cycle:** Monthly