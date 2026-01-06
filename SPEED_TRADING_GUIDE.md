# ⚡ Speed Trading (Scalp Mode) Guide

## Overview

Speed Trading mode is designed for **quick in-and-out profits** on early pump.fun launches. This strategy targets tokens with strong momentum in the first few minutes, aiming to capture 30-100% gains before rug pulls occur.

## Strategy Philosophy

Unlike the conservative filtering modes, Speed Trading:
- **Buys very early** (within seconds/minutes of launch)
- **Exits quickly** (2-5 minutes max hold time)
- **Focuses on momentum** rather than fundamentals
- **Uses trailing stops** to lock in profits
- **Smaller position sizes** for risk management

## How It Works

### 1. Momentum Detection

The speed trader analyzes:
- **Liquidity Growth Rate**: How fast SOL is entering the bonding curve
- **Momentum Score**: SOL per minute growth rate
- **Age**: Prefers tokens < 3 minutes old
- **Activity**: Rejects tokens with negative liquidity growth

### 2. Entry Signals

**Strong Momentum (85% confidence)**
- Liquidity growing > 2 SOL/min
- Token age < 2 minutes
- Liquidity growth > 5 SOL

**Good Momentum (70% confidence)**
- Liquidity growing > 1 SOL/min
- Token age < 3 minutes
- Liquidity growth > 2 SOL

**Early Catch (60% confidence)**
- Liquidity growing > 0.5 SOL/min
- Token age < 1 minute
- Some positive growth

### 3. Exit Strategy (Adaptive)

The exit strategy adapts based on momentum:

**High Momentum (>2 SOL/min)**
- Take Profit: 100% (2x target)
- Stop Loss: 20%
- Max Hold: 5 minutes
- Trailing Stop: 10% from peak

**Good Momentum (>1 SOL/min)**
- Take Profit: 75% (1.75x target)
- Stop Loss: 18%
- Max Hold: 4 minutes
- Trailing Stop: 10% from peak

**Moderate Momentum (>0.5 SOL/min)**
- Take Profit: 50% (1.5x target)
- Stop Loss: 15%
- Max Hold: 3 minutes
- Trailing Stop: 10% from peak

**Very Early Scalp (<30s old)**
- Take Profit: 30% (quick profit)
- Stop Loss: 10% (tight)
- Max Hold: 2 minutes
- Trailing Stop: 10% from peak

### 4. Trailing Stop Logic

Once a trade gains 20%+:
- Tracks the highest price reached
- If price drops 10% from peak, automatically sells
- Locks in profits while allowing for upside

### 5. Time-Based Exit

All speed trades have a maximum hold time:
- Prevents holding through rug pulls
- Forces quick decision-making
- Exits even if TP/SL not hit

## Usage

### Setup

1. **Select "⚡ SCALP" mode** in Bot Controls
2. **Set position size** (recommended: 0.01-0.02 SOL per trade)
3. **Enable Paper Trading** first to test
4. **Start the bot**

### What to Expect

**Logs will show:**
```
⚡ SPEED BUY: TOKEN123 - 🔥 STRONG MOMENTUM: +8.5 SOL in 45s (11.3 SOL/min)
   Confidence: 85% | Momentum: 11.30 SOL/min
   Exit Strategy: TP 100% | SL 20% | Max Hold: 300s
```

**Successful trades:**
- Entry within 1-2 minutes of launch
- Exit within 2-5 minutes
- Profit: 30-100% gains
- Quick turnaround for next trade

**Failed trades:**
- Rug pull happens before exit
- Momentum dies quickly
- Stop loss triggered

## Risk Management

### Position Sizing
- **Recommended**: 0.01-0.02 SOL per trade
- **Maximum**: 0.05 SOL (even in high-risk scenarios)
- **Rationale**: Small positions = can take many trades = higher win rate needed

### Concurrent Trades
- **Recommended**: 2-3 max concurrent trades
- **Rationale**: Diversify risk, but not too many (hard to monitor)

### Stop Loss
- **Always enabled**: 10-20% depending on momentum
- **Critical**: Prevents catastrophic losses

### Time Limits
- **Always enforced**: Max 2-5 minutes per trade
- **Rationale**: Prevents holding through rugs

## Expected Performance

### Win Rate
- **Target**: 40-60% win rate
- **Reality**: 30-50% is more realistic (98.6% of tokens are scams)
- **Key**: Winners need to be 2-3x larger than losers

### Profit Targets
- **Conservative**: 30-50% per winning trade
- **Aggressive**: 50-100% per winning trade
- **Average**: 40-60% per winning trade

### Example Scenario
- 10 trades: 4 wins @ 50% avg, 6 losses @ 15% avg
- Net: +200% - 90% = +110% profit
- **Key**: Need winners to be 2-3x larger than losers

## Tips for Success

### 1. Monitor Momentum
- Watch for tokens with rapidly growing liquidity
- Avoid tokens with flat or declining liquidity
- Look for 2+ SOL/min growth rate

### 2. Quick Exits
- Don't get greedy - take profits early
- Use trailing stops to lock in gains
- Exit at first sign of weakness

### 3. Avoid These
- Tokens older than 5 minutes (too late)
- Negative liquidity growth (rug in progress)
- No momentum (dead token)

### 4. Best Times
- High activity periods (more launches = more opportunities)
- Early morning/late night (less competition)
- Weekends (more retail activity)

### 5. Paper Trade First
- Test the strategy with paper trading
- Understand the exit logic
- Get comfortable with the speed

## Comparison to Other Modes

| Mode | Entry Time | Hold Time | Target Profit | Risk |
|------|-----------|-----------|---------------|------|
| **Scalp** | <2 min | 2-5 min | 30-100% | High |
| **Safe** | 1-5 min | 10-30 min | 20-50% | Low |
| **Medium** | <3 min | 5-15 min | 50-100% | Medium |
| **High** | <1 min | 5-20 min | 100%+ | Very High |

## Technical Details

### Momentum Calculation
```
Momentum = (Liquidity Change / Time) * 60
Example: +5 SOL in 30 seconds = 10 SOL/min
```

### Confidence Score
- Based on momentum rate
- Age of token
- Liquidity growth amount
- Minimum 50% required to buy

### Exit Triggers
1. **Take Profit**: Price reaches target %
2. **Stop Loss**: Price drops to stop %
3. **Trailing Stop**: Drops 10% from peak (after 20% gain)
4. **Time Limit**: Max hold time reached

## Warnings

⚠️ **High Risk**: Speed trading is extremely risky
⚠️ **98.6% Scam Rate**: Most tokens will still be rugs
⚠️ **Fast Action Required**: Need to monitor closely
⚠️ **Gas Costs**: Frequent trading = higher gas costs
⚠️ **Slippage**: Early trades may have high slippage

## Best Practices

1. ✅ Start with paper trading
2. ✅ Use small position sizes (0.01 SOL)
3. ✅ Monitor actively (don't set and forget)
4. ✅ Set appropriate stop losses
5. ✅ Take profits early (don't get greedy)
6. ✅ Limit concurrent trades (2-3 max)
7. ✅ Track performance and adjust

## Conclusion

Speed Trading is a high-risk, high-reward strategy for experienced traders. It requires:
- Fast decision-making
- Active monitoring
- Strict risk management
- Acceptance of high loss rate

**Remember**: Even with momentum detection, most tokens are scams. The key is making winners 2-3x larger than losers and maintaining a 40%+ win rate.

Good luck! 🚀








