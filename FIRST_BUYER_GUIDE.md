# 🚀 First Buyer Mode Guide

## Overview

**First Buyer Mode** is an ultra-aggressive scalping strategy that:
- **Buys tokens within 1-10 seconds** of launch detection
- **Holds for ~6 seconds** (or until momentum detected)
- **Exits quickly** before rug pulls happen
- **Profits from early pump** when others start buying

## Strategy Philosophy

The idea is simple: **Be first to buy, profit from the early pump, exit before the rug**.

When a new token launches:
1. You buy immediately (within seconds)
2. Other traders see activity and start buying
3. Price pumps 20-50% in seconds
4. You sell after 6 seconds (or when momentum detected)
5. Profit before the rug pull happens

## How It Works

### Entry Criteria

**Perfect Entry (90% confidence)**
- Token age: < 5 seconds
- Liquidity growth: > 0.1 SOL
- Action: BUY immediately

**Good Entry (75% confidence)**
- Token age: < 10 seconds
- Liquidity growth: > 0.2 SOL
- Action: BUY

**Okay Entry (60% confidence)**
- Token age: < 15 seconds
- Liquidity growth: > 0.5 SOL
- Action: BUY (if no better options)

**Rejected**
- Token age: > 15 seconds (too late)
- Liquidity draining (instant rug)
- No activity detected

### Exit Strategy

**Time-Based Exit (Primary)**
- Default: 6 seconds after entry
- Adjusts based on momentum:
  - Strong momentum (>2 SOL/min): 8 seconds, 50% TP
  - Good momentum (>1 SOL/min): 6 seconds, 40% TP
  - Weak momentum: 5 seconds, 25% TP
  - Very early (<3s): 4 seconds, 20% TP

**Momentum-Based Exit (Secondary)**
- Monitors for price increases (others buying)
- Exits early if:
  - Minimum hold time passed (3 seconds)
  - Profit > 5%
  - Price rising (momentum detected)
  - Hits 50% of take profit target

**Stop Loss**
- Very tight: 8-12% depending on momentum
- Prevents catastrophic losses

**Take Profit**
- Quick profits: 20-50% depending on momentum
- Strong momentum = higher TP (50%)
- Weak momentum = lower TP (20-25%)

## Usage

### Setup

1. **Select "🚀 FIRST" mode** in Bot Controls
2. **Set position size**: 0.01 SOL (small for high frequency)
3. **Enable Paper Trading** first to test
4. **Start the bot**

### What to Expect

**Logs will show:**
```
🚀 FIRST BUYER: TOKEN123 - ⚡ FIRST BUYER: 2.3s old, +0.5 SOL
   Confidence: 90% | Entry Time: 10:30:45 AM
   Exit Strategy: 6s hold | TP 30% | SL 10%
```

**Successful trades:**
- Entry within 1-5 seconds of launch
- Exit after 6 seconds (or momentum detected)
- Profit: 20-50% in 6-8 seconds
- Very quick turnaround

**Failed trades:**
- Rug pull happens before 6 seconds
- No momentum (price doesn't pump)
- Stop loss triggered

## Risk Management

### Position Sizing
- **Recommended**: 0.01 SOL per trade
- **Maximum**: 0.02 SOL (even in high-risk scenarios)
- **Rationale**: High frequency = many trades = small positions

### Concurrent Trades
- **Recommended**: 3-5 max concurrent trades
- **Rationale**: More opportunities = more chances to profit
- **Warning**: Don't go too high (hard to monitor)

### Stop Loss
- **Always enabled**: 8-12% (very tight)
- **Critical**: Prevents holding through rugs
- **Fast exits**: Losses are small and quick

### Time Limits
- **Always enforced**: 4-8 seconds max per trade
- **Rationale**: Prevents holding through rugs
- **Quick decisions**: Forces fast profit-taking

## Expected Performance

### Win Rate
- **Target**: 40-60% win rate
- **Reality**: 30-50% is more realistic (98.6% of tokens are scams)
- **Key**: Winners need to be 2-3x larger than losers

### Profit Targets
- **Conservative**: 20-30% per winning trade
- **Aggressive**: 30-50% per winning trade
- **Average**: 25-40% per winning trade

### Example Scenario
- 20 trades: 8 wins @ 35% avg, 12 losses @ 10% avg
- Net: +280% - 120% = +160% profit
- **Key**: Need winners to be 2-3x larger than losers

### Gas Costs
- **Important**: Frequent trading = higher gas costs
- **Estimate**: ~0.001-0.002 SOL per trade (buy + sell)
- **Impact**: Need 2-3% profit just to cover gas
- **Solution**: Only trade when confidence is high

## Tips for Success

### 1. Speed is Everything
- Bot must detect tokens within 1-5 seconds
- Use Helius API for faster connections
- Monitor connection status

### 2. Momentum Detection
- Watch for liquidity growth
- Exit early if momentum detected (others buying)
- Don't wait for full 6 seconds if profit is good

### 3. Avoid These
- Tokens older than 15 seconds (too late)
- Negative liquidity growth (rug in progress)
- No activity (dead token)

### 4. Best Times
- High activity periods (more launches = more opportunities)
- Early morning/late night (less competition)
- Weekends (more retail activity)

### 5. Paper Trade First
- Test the strategy with paper trading
- Understand the 6-second exit logic
- Get comfortable with the speed

## Comparison to Other Modes

| Mode | Entry Time | Hold Time | Target Profit | Risk |
|------|-----------|-----------|---------------|------|
| **First** | <5s | 4-8s | 20-50% | Very High |
| **Scalp** | <2 min | 2-5 min | 30-100% | High |
| **Safe** | 1-5 min | 10-30 min | 20-50% | Low |
| **Medium** | <3 min | 5-15 min | 50-100% | Medium |
| **High** | <1 min | 5-20 min | 100%+ | Very High |

## Technical Details

### Polling Frequency
- **First Buyer Mode**: 3 seconds (faster price updates)
- **Other Modes**: 12 seconds (standard)
- **Rationale**: Need fast price updates for 6-second exits

### Entry Detection
- Monitors token age (seconds since launch)
- Checks liquidity growth (SOL entering bonding curve)
- Calculates momentum (SOL per minute)

### Exit Triggers
1. **Time Limit**: Max hold time reached (4-8 seconds)
2. **Momentum**: Price rising + profit > 5% (early exit)
3. **Take Profit**: Price reaches target %
4. **Stop Loss**: Price drops to stop %

## Warnings

⚠️ **Extremely High Risk**: First Buyer mode is the riskiest strategy
⚠️ **98.6% Scam Rate**: Most tokens will still be rugs
⚠️ **Gas Costs**: Frequent trading = high gas costs
⚠️ **Speed Required**: Need very fast connections
⚠️ **Slippage**: Early trades may have high slippage
⚠️ **Competition**: Many bots competing for first buys

## Best Practices

1. ✅ Start with paper trading
2. ✅ Use very small position sizes (0.01 SOL)
3. ✅ Monitor actively (don't set and forget)
4. ✅ Set tight stop losses (8-10%)
5. ✅ Take profits early (don't get greedy)
6. ✅ Limit concurrent trades (3-5 max)
7. ✅ Use Helius API for speed
8. ✅ Track performance and adjust
9. ✅ Accept high loss rate (30-50%)
10. ✅ Focus on making winners 2-3x larger than losers

## Profitability Math

**Example: 100 trades**
- 40 wins @ 35% avg = +1,400% profit
- 60 losses @ 10% avg = -600% loss
- Gas costs (100 trades @ 0.002 SOL) = -20% (assuming 0.01 SOL trades)
- **Net Profit**: +780% (7.8x return)

**Key Factors:**
- Win rate: Need 35-50%+
- Average win: Need 2-3x average loss
- Gas costs: Need 2-3% profit to cover
- Frequency: More trades = more opportunities

## Conclusion

First Buyer Mode is the **most aggressive and risky** strategy. It requires:
- Very fast connections (Helius API recommended)
- Active monitoring
- Strict risk management
- Acceptance of high loss rate
- Focus on quick profits

**Remember**: Even with first buyer detection, most tokens are scams. The key is:
- Making winners 2-3x larger than losers
- Maintaining 40%+ win rate
- Exiting quickly before rugs
- Managing gas costs

**This is experimental and extremely risky. Use small amounts and test thoroughly!**

Good luck! 🚀








