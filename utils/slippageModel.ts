/**
 * Dynamic slippage model.
 *
 * Pump.fun's slippage parameter is a tolerance cap, not a cost. A stricter
 * cap does not give us a better fill — it just makes the trade more likely
 * to fail outright (leaving us with a burned priority fee and, on an exit,
 * a stuck position). A looser cap lets the trade execute but in calm
 * conditions we still fill at whatever the AMM curve says; we never "pay"
 * the tolerance, we pay the actual impact.
 *
 * This module picks a tolerance that:
 *   - Never goes below the preset's configured slippage (that's the floor).
 *   - Bumps upward when entry conditions are volatile, so we don't miss
 *     legitimate fills to front-running drift.
 *   - Bumps significantly upward when we need to exit a token whose pool
 *     has drained — in a rug, the curve has shifted so far that the preset
 *     slippage will reject our sell and strand us in the position.
 *
 * The return value also includes a human-readable reason trail so the
 * runner can log WHY the slippage was adjusted, which is useful for
 * post-mortem on failed trades.
 */

export interface BuySlippageInput {
    // Configured preset slippage (god/micro/degen/sniper/custom).
    baseSlippagePercent: number;
    // SOL in the bonding curve at observation time.
    liquiditySol: number;
    // Amount of SOL we are about to spend.
    amountSol: number;
    // Max price change observed on this token over the recent tape window (%),
    // from the market snapshot. Undefined if we don't have a snapshot yet.
    recentPriceChangePercent?: number;
    // Bonding curve velocity in % per minute from the snapshot.
    curveVelocityPercent?: number;
}

export interface SellSlippageInput {
    baseSlippagePercent: number;
    closeReason: string;
    // Liquidity at the time the position was opened.
    initialLiquiditySol?: number;
    // Liquidity right now.
    currentLiquiditySol?: number;
    // How long we've been holding the position (seconds). Longer holds on
    // thin pools benefit from slightly higher slippage since dust rounding
    // and curve drift compound.
    holdDurationSeconds?: number;
}

export interface SlippageDecision {
    slippagePercent: number;
    reasons: string[];
}

const BUY_MIN_FLOOR = 1;
const BUY_CEILING = 60;
const SELL_FLOOR_MIN = 25;   // Preserves the old Math.max(cfg, 25) behavior.
const SELL_CEILING = 90;

// Panic closes need the exit to go through. If we hesitate and the sell
// fails once, we often end up holding a dead bag — the curve keeps moving
// in the wrong direction while we try a second attempt.
const PANIC_REASONS = [
    'fast kill',
    'stop loss',
    'liquidity drop',
    'rug',
    'adaptive trail',
    'profit protection',
    'fast stall',
    'fast giveback'
];

export function isPanicExit(closeReason: string): boolean {
    if (!closeReason) return false;
    const normalized = closeReason.toLowerCase();
    return PANIC_REASONS.some((marker) => normalized.includes(marker));
}

function clamp(value: number, lo: number, hi: number): number {
    if (!Number.isFinite(value)) return lo;
    return Math.max(lo, Math.min(hi, value));
}

export function computeDynamicBuySlippage(input: BuySlippageInput): SlippageDecision {
    const base = Math.max(BUY_MIN_FLOOR, input.baseSlippagePercent || 0);
    const reasons: string[] = [`base ${base.toFixed(1)}%`];
    let adjusted = base;

    // Self-impact from the AMM curve. Pump.fun trades are small enough that
    // self-impact is usually < 0.5%, but on a nearly-empty pool a 0.025 SOL
    // buy can push the price 2%+, which would exceed a 12% tolerance once
    // combined with drift + fee.
    if (Number.isFinite(input.liquiditySol) && input.liquiditySol > 0 && input.amountSol > 0) {
        const impactPercent = (input.amountSol / input.liquiditySol) * 100;
        if (impactPercent > 1.5) {
            const bump = Math.min(15, impactPercent * 1.5);
            adjusted += bump;
            reasons.push(`self-impact ${impactPercent.toFixed(2)}% -> +${bump.toFixed(1)}%`);
        }
    }

    // If the token is moving fast, the price will probably shift between
    // our observation and the fill. Raise tolerance so a still-legitimate
    // fill doesn't get rejected.
    if (Number.isFinite(input.recentPriceChangePercent) && (input.recentPriceChangePercent as number) > 15) {
        const bump = Math.min(12, (input.recentPriceChangePercent as number) * 0.25);
        adjusted += bump;
        reasons.push(`recent move ${(input.recentPriceChangePercent as number).toFixed(0)}% -> +${bump.toFixed(1)}%`);
    }

    if (Number.isFinite(input.curveVelocityPercent) && (input.curveVelocityPercent as number) > 1.0) {
        const bump = Math.min(6, (input.curveVelocityPercent as number) * 2);
        adjusted += bump;
        reasons.push(`velocity ${(input.curveVelocityPercent as number).toFixed(2)}%/min -> +${bump.toFixed(1)}%`);
    }

    const slippagePercent = clamp(adjusted, base, BUY_CEILING);
    if (slippagePercent !== adjusted) {
        reasons.push(`clamped to ${slippagePercent.toFixed(1)}%`);
    }
    return { slippagePercent, reasons };
}

export function computeDynamicSellSlippage(input: SellSlippageInput): SlippageDecision {
    const base = Math.max(BUY_MIN_FLOOR, input.baseSlippagePercent || 0);
    // Sells have a higher hard floor because an orphaned position is worse
    // than an imperfect fill.
    let adjusted = Math.max(base, SELL_FLOOR_MIN);
    const reasons: string[] = [`floor ${adjusted.toFixed(1)}%`];

    // Panic exits need maximum execution probability. Liquidity is usually
    // draining fast and the curve is shifting against us.
    if (isPanicExit(input.closeReason)) {
        adjusted += 20;
        reasons.push(`panic (${input.closeReason}) -> +20%`);
    }

    // Liquidity drop since entry is the single best predictor of a stuck
    // sell. If the pool has lost 30% SOL we need AT LEAST 30% tolerance
    // over the curve's new position.
    if (
        Number.isFinite(input.initialLiquiditySol) && (input.initialLiquiditySol as number) > 0 &&
        Number.isFinite(input.currentLiquiditySol) && (input.currentLiquiditySol as number) >= 0
    ) {
        const initial = input.initialLiquiditySol as number;
        const current = input.currentLiquiditySol as number;
        const dropPercent = Math.max(0, (1 - current / initial) * 100);
        if (dropPercent > 5) {
            const bump = Math.min(35, dropPercent);
            adjusted += bump;
            reasons.push(`liq drop ${dropPercent.toFixed(0)}% -> +${bump.toFixed(0)}%`);
        }
    }

    // Long holds on Pump.fun often see gradual liquidity leakage even on
    // healthy tokens. Add a small buffer after a few minutes.
    if (Number.isFinite(input.holdDurationSeconds) && (input.holdDurationSeconds as number) > 180) {
        adjusted += 5;
        reasons.push(`long hold -> +5%`);
    }

    const slippagePercent = clamp(adjusted, SELL_FLOOR_MIN, SELL_CEILING);
    if (slippagePercent !== adjusted) {
        reasons.push(`clamped to ${slippagePercent.toFixed(1)}%`);
    }
    return { slippagePercent, reasons };
}
