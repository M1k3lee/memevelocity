import type { ManagedExitStrategy } from './tradeExit';
import {
    PUMP_FEE_RATE,
    simulatePumpBuy,
    simulatePumpSell,
    calculatePumpPrice
} from './pumpMath';

export const PAPER_BASE_TX_FEE_SOL = 0.00001;

/**
 * Expected adverse price drift between signal time and on-chain confirmation.
 *
 * In live trading there are ~1-3 seconds between submitting a transaction and it
 * landing. If the token is actively moving the curve drifts against us. Paper
 * used to fill instantly, which is why paper looked consistently better than
 * live. We bake a small deterministic drift into the fill so paper and live
 * average out to the same place.
 *
 * Fast trades (short maxHoldTime) hit faster-moving tokens, so drift is larger.
 * These numbers match observed mean drift from captured live trades.
 */
const PAPER_CONFIRM_DRIFT_FAST_PERCENT = 1.6;
const PAPER_CONFIRM_DRIFT_NORMAL_PERCENT = 0.9;

/**
 * Probability that an exit transaction fails on the first attempt (slippage
 * exceeded, pool moved, RPC congested) and has to retry with the much larger
 * fallback slippage. Measured from production runs at ~10-15%. We retry at the
 * fallback slippage which is far more costly on thin pools.
 */
const PAPER_EXIT_FIRST_ATTEMPT_FAILURE_RATE = 0.12;

/**
 * When an exit fails and retries with fallback slippage, this is the additional
 * price give-up vs. the first-attempt fill. Modelled as an additive percent on
 * top of what the primary slippage cost us.
 */
const PAPER_EXIT_RETRY_EXTRA_PENALTY_PERCENT_FAST = 5;
const PAPER_EXIT_RETRY_EXTRA_PENALTY_PERCENT_NORMAL = 12;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/**
 * Deterministic pseudo-random in [0, 1) seeded from a string. We want paper
 * fills to be reproducible so replay results don't change between runs; but we
 * also want different tokens to get different random outcomes (not every exit
 * fails or none of them). Hashing the mint gives us both.
 */
function seededRand(seed: string): number {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    // unsigned, normalise to [0, 1)
    return ((h >>> 0) % 1_000_000) / 1_000_000;
}

export function isFastTradeExitStrategy(exitStrategy?: Pick<ManagedExitStrategy, 'maxHoldTime'> | null): boolean {
    return !!exitStrategy?.maxHoldTime && exitStrategy.maxHoldTime <= 45;
}

export function getLiveBuyExecutionPlan(
    amountSol: number,
    requestedSlippagePercent: number,
    exitStrategy?: Pick<ManagedExitStrategy, 'maxHoldTime'> | null
) {
    const fastTrade = isFastTradeExitStrategy(exitStrategy);
    const initialPriorityFeeSol =
        amountSol <= 0.05
            ? 0.0003
            : Math.max(0.001, Math.min(0.003, amountSol * 0.05));

    return {
        fastTrade,
        initialSlippagePercent: requestedSlippagePercent,
        initialPriorityFeeSol,
        maxRetrySlippagePercent: fastTrade ? 20 : 65,
        slippageRetryIncrementPercent: fastTrade ? 2 : 15,
        transportRetryIncrementPercent: fastTrade ? 2 : 10,
        slippageRetryPriorityIncrementSol: 0.0007,
        transportRetryPriorityIncrementSol: 0.0009,
        maxPriorityFeeSol: 0.0045
    };
}

export function getLiveSellExecutionPlan(
    amountSolPaid: number,
    exitStrategy?: Pick<ManagedExitStrategy, 'maxHoldTime'> | null
) {
    const fastTrade = isFastTradeExitStrategy(exitStrategy);
    const priorityFeeSol =
        amountSolPaid <= 0.05
            ? 0.0003
            : Math.max(0.0005, Math.min(0.002, amountSolPaid * 0.02));

    return {
        fastTrade,
        primarySlippagePercent: fastTrade ? 18 : 25,
        fallbackSlippagePercent: fastTrade ? 28 : 50,
        priorityFeeSol,
        fallbackPriorityFeeSol: 0.003
    };
}

/**
 * Heuristic paper fill price when we DO NOT have current curve state. Kept for
 * backwards compatibility — new callers should prefer the curve-aware
 * simulate* functions below, which use real AMM math.
 *
 * This is the "best effort when blind" path: the slippage penalty modelled
 * here has been tuned up from the original version to at least come close to
 * live fill cost (the old cap of 2.2-3.25% was a large underestimate).
 */
export function estimatePaperFillPrice(params: {
    observedPrice: number;
    side: 'buy' | 'sell';
    requestedSlippagePercent: number;
    amountSol: number;
    exitStrategy?: Pick<ManagedExitStrategy, 'maxHoldTime'> | null;
}): number {
    const { observedPrice, side, requestedSlippagePercent, amountSol, exitStrategy } = params;

    if (!Number.isFinite(observedPrice) || observedPrice <= 0) {
        return 0;
    }

    const fastTrade = isFastTradeExitStrategy(exitStrategy);
    const sizeFactor = amountSol <= 0.01 ? 1.1 : amountSol <= 0.05 ? 0.95 : 0.8;
    // Sell side is meaningfully worse than buy side on pump.fun curves because
    // liquidity is typically thin on exit and the curve is asymmetric.
    const sideFactor = side === 'buy' ? 0.22 : 0.32;
    const fastFactor = fastTrade ? 1.3 : 1;
    const confirmDrift = fastTrade ? PAPER_CONFIRM_DRIFT_FAST_PERCENT : PAPER_CONFIRM_DRIFT_NORMAL_PERCENT;
    // The protocol fee applies on both legs: +1% adverse on every fill.
    const protocolFeePercent = PUMP_FEE_RATE * 100;
    const fillPenaltyPercent = clamp(
        (requestedSlippagePercent * sideFactor * sizeFactor * fastFactor) + confirmDrift + protocolFeePercent,
        0.5,
        fastTrade ? 18 : 14
    );
    const multiplier = side === 'buy'
        ? 1 + (fillPenaltyPercent / 100)
        : Math.max(0, 1 - (fillPenaltyPercent / 100));

    return observedPrice * multiplier;
}

export interface PaperBuySimulationResult {
    fillPrice: number;
    tokensOut: number;
    networkFeeSol: number;
    protocolFeeSol: number;
    /** New curve state after the simulated trade (for use in replay and exit sim). */
    newVSol?: number;
    newVTokens?: number;
}

export interface PaperSellSimulationResult {
    fillPrice: number;
    grossProceedsSol: number;
    netProceedsSol: number;
    networkFeeSol: number;
    protocolFeeSol: number;
    /** True if the simulated sell had to retry at fallback slippage. */
    retried: boolean;
    newVSol?: number;
    newVTokens?: number;
}

/**
 * Curve-aware buy simulation. When we know the bonding curve state we walk the
 * real constant-product formula, charge the 1% pump.fun fee, and apply a small
 * confirmation-window drift that approximates what happens between signal and
 * on-chain fill. This is the simulation path that should be used everywhere a
 * paper buy is executed if the curve state is available.
 */
export function simulatePaperBuy(params: {
    observedPrice: number;
    amountSol: number;
    requestedSlippagePercent: number;
    curve?: { vSolInBondingCurve?: number; vTokensInBondingCurve?: number } | null;
    exitStrategy?: Pick<ManagedExitStrategy, 'maxHoldTime'> | null;
}): PaperBuySimulationResult {
    const { observedPrice, amountSol, requestedSlippagePercent, curve, exitStrategy } = params;
    const executionPlan = getLiveBuyExecutionPlan(amountSol, requestedSlippagePercent, exitStrategy);
    const fastTrade = executionPlan.fastTrade;
    const networkFeeSol = PAPER_BASE_TX_FEE_SOL + executionPlan.initialPriorityFeeSol;

    const sim = curve ? simulatePumpBuy(curve.vSolInBondingCurve, curve.vTokensInBondingCurve, amountSol) : null;

    // Apply confirmation-window drift: the curve moved against us during the
    // 1-3s between submitting and confirming. We bias the effective fill price
    // up (buys are adverse if the token is moving up).
    const confirmDrift = fastTrade ? PAPER_CONFIRM_DRIFT_FAST_PERCENT : PAPER_CONFIRM_DRIFT_NORMAL_PERCENT;

    if (sim && sim.tokensOut > 0) {
        const driftedPrice = sim.effectivePrice * (1 + confirmDrift / 100);
        const tokensAfterDrift = (amountSol - sim.feeSol) > 0
            ? (amountSol - sim.feeSol) / driftedPrice
            : 0;
        return {
            fillPrice: driftedPrice,
            tokensOut: Math.max(0, tokensAfterDrift),
            networkFeeSol,
            protocolFeeSol: sim.feeSol,
            newVSol: sim.newVSol,
            newVTokens: sim.newVTokens
        };
    }

    // No curve state available — fall back to the heuristic.
    const fillPrice = estimatePaperFillPrice({
        observedPrice,
        side: 'buy',
        requestedSlippagePercent,
        amountSol,
        exitStrategy
    });
    const protocolFeeSol = amountSol * PUMP_FEE_RATE;
    const tokensOut = fillPrice > 0 ? Math.max(0, (amountSol - protocolFeeSol)) / fillPrice : 0;

    return {
        fillPrice,
        tokensOut,
        networkFeeSol,
        protocolFeeSol
    };
}

/**
 * Curve-aware sell simulation. Uses real AMM math, the 1% fee, confirmation
 * drift (which is adverse on the sell side), AND models a ~12% probability
 * that the first attempt fails and the sell retries at fallback slippage.
 *
 * The failure outcome is deterministic per mint+buyTime so replay is stable.
 */
export function simulatePaperSell(params: {
    observedPrice: number;
    amountTokens: number;
    amountSolPaid: number;
    curve?: { vSolInBondingCurve?: number; vTokensInBondingCurve?: number } | null;
    exitStrategy?: Pick<ManagedExitStrategy, 'maxHoldTime'> | null;
    /** Unique seed for deterministic failure simulation (e.g. `${mint}:${buyTime}:${stage}`). */
    failureSeed?: string;
    /** Override the base failure probability for tests or extreme-condition modelling. */
    failureRate?: number;
}): PaperSellSimulationResult {
    const { observedPrice, amountTokens, amountSolPaid, curve, exitStrategy, failureSeed, failureRate } = params;
    const executionPlan = getLiveSellExecutionPlan(amountSolPaid, exitStrategy);
    const fastTrade = executionPlan.fastTrade;
    const networkFeeSol = PAPER_BASE_TX_FEE_SOL + executionPlan.priorityFeeSol;

    // Determine if the first attempt fails. Deterministic given the seed.
    const effectiveFailureRate = clamp(failureRate ?? PAPER_EXIT_FIRST_ATTEMPT_FAILURE_RATE, 0, 0.5);
    const retried = failureSeed ? seededRand(failureSeed) < effectiveFailureRate : false;

    let grossProceedsSol = 0;
    let fillPrice = 0;
    let protocolFeeSol = 0;
    let newVSol: number | undefined;
    let newVTokens: number | undefined;

    const sim = curve ? simulatePumpSell(curve.vSolInBondingCurve, curve.vTokensInBondingCurve, amountTokens) : null;
    const confirmDrift = fastTrade ? PAPER_CONFIRM_DRIFT_FAST_PERCENT : PAPER_CONFIRM_DRIFT_NORMAL_PERCENT;

    if (sim && sim.solOut > 0) {
        grossProceedsSol = sim.solOut * (1 - confirmDrift / 100);
        protocolFeeSol = sim.feeSol;
        newVSol = sim.newVSol;
        newVTokens = sim.newVTokens;
    } else {
        fillPrice = estimatePaperFillPrice({
            observedPrice,
            side: 'sell',
            requestedSlippagePercent: executionPlan.primarySlippagePercent,
            amountSol: amountSolPaid,
            exitStrategy
        });
        const gross = amountTokens * fillPrice;
        protocolFeeSol = gross * PUMP_FEE_RATE;
        grossProceedsSol = Math.max(0, gross - protocolFeeSol);
    }

    if (retried) {
        // First attempt failed; retry ate the fallback slippage — meaningful
        // extra give-up on thin pools.
        const extraPenalty = fastTrade
            ? PAPER_EXIT_RETRY_EXTRA_PENALTY_PERCENT_FAST
            : PAPER_EXIT_RETRY_EXTRA_PENALTY_PERCENT_NORMAL;
        grossProceedsSol = grossProceedsSol * (1 - extraPenalty / 100);
    }

    fillPrice = amountTokens > 0 ? grossProceedsSol / amountTokens : 0;
    const netProceedsSol = Math.max(0, grossProceedsSol - networkFeeSol);

    return {
        fillPrice,
        grossProceedsSol,
        netProceedsSol,
        networkFeeSol,
        protocolFeeSol,
        retried,
        newVSol,
        newVTokens
    };
}

// Re-export for convenience so callers can get the fee rate via this module.
export { PUMP_FEE_RATE };
