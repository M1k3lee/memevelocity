const PUMP_TOKEN_DECIMALS = 1_000_000;
const PUMP_RAW_TOKEN_THRESHOLD = 10_000_000_000;
const PUMP_INITIAL_VIRTUAL_TOKENS = 1_073_000_000;
const PUMP_CURVE_SALE_TOKENS = 793_100_000;

// Pump.fun charges a protocol fee on both buys and sells.
// Confirmed from on-chain observations; at time of writing the fee is 1%.
// (If pump.fun changes this, update here — it's the single source of truth.)
export const PUMP_FEE_RATE = 0.01;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function normalizePumpVirtualTokens(vTokensInBondingCurve?: number): number {
    if (!Number.isFinite(vTokensInBondingCurve) || !vTokensInBondingCurve || vTokensInBondingCurve <= 0) {
        return 0;
    }

    return vTokensInBondingCurve > PUMP_RAW_TOKEN_THRESHOLD
        ? vTokensInBondingCurve / PUMP_TOKEN_DECIMALS
        : vTokensInBondingCurve;
}

export function calculatePumpPrice(vSolInBondingCurve?: number, vTokensInBondingCurve?: number): number {
    if (!Number.isFinite(vSolInBondingCurve) || !vSolInBondingCurve || vSolInBondingCurve <= 0) {
        return 0;
    }

    const normalizedTokens = normalizePumpVirtualTokens(vTokensInBondingCurve);
    if (normalizedTokens <= 0) return 0;

    return vSolInBondingCurve / normalizedTokens;
}

export function calculateBondingCurveProgress(vTokensInBondingCurve?: number): number {
    const normalizedTokens = normalizePumpVirtualTokens(vTokensInBondingCurve);
    if (normalizedTokens <= 0) return 0;

    const progress = ((PUMP_INITIAL_VIRTUAL_TOKENS - normalizedTokens) / PUMP_CURVE_SALE_TOKENS) * 100;
    return clamp(progress, 0, 100);
}

export interface PumpBuySimulation {
    /** Tokens received for the input SOL (after protocol fee). */
    tokensOut: number;
    /** Effective price paid per token = amountSolAfterFee / tokensOut. */
    effectivePrice: number;
    /** Virtual SOL reserve after the buy (fee NOT added to reserves). */
    newVSol: number;
    /** Virtual token reserve after the buy. */
    newVTokens: number;
    /** SOL fee paid to the pump.fun protocol. */
    feeSol: number;
}

export interface PumpSellSimulation {
    /** SOL received for the input tokens (after protocol fee). */
    solOut: number;
    /** Effective price received per token. */
    effectivePrice: number;
    /** Virtual SOL reserve after the sell. */
    newVSol: number;
    /** Virtual token reserve after the sell. */
    newVTokens: number;
    /** SOL fee paid to the pump.fun protocol. */
    feeSol: number;
}

/**
 * Simulate buying `amountSol` worth of tokens from the pump.fun bonding curve
 * using real constant-product AMM math plus the protocol fee.
 *
 * Returns the actual tokens the trader would receive and the new curve state.
 * If inputs are invalid (missing curve state, non-positive size) returns null so
 * callers can fall back to a heuristic.
 */
export function simulatePumpBuy(
    vSolInBondingCurve: number | undefined,
    vTokensInBondingCurve: number | undefined,
    amountSol: number,
    feeRate: number = PUMP_FEE_RATE
): PumpBuySimulation | null {
    if (!Number.isFinite(amountSol) || amountSol <= 0) return null;
    if (!Number.isFinite(vSolInBondingCurve) || !vSolInBondingCurve || vSolInBondingCurve <= 0) return null;
    const vTokens = normalizePumpVirtualTokens(vTokensInBondingCurve);
    if (vTokens <= 0) return null;

    const safeFee = clamp(feeRate, 0, 0.05);
    const feeSol = amountSol * safeFee;
    const solIntoCurve = amountSol - feeSol;
    if (solIntoCurve <= 0) return null;

    const k = vSolInBondingCurve * vTokens;
    const newVSol = vSolInBondingCurve + solIntoCurve;
    const newVTokens = k / newVSol;
    const tokensOut = Math.max(0, vTokens - newVTokens);
    if (tokensOut <= 0) return null;

    return {
        tokensOut,
        effectivePrice: amountSol / tokensOut,
        newVSol,
        newVTokens,
        feeSol
    };
}

/**
 * Simulate selling `amountTokens` into the pump.fun bonding curve.
 * Returns the actual SOL the trader would receive after the protocol fee.
 */
export function simulatePumpSell(
    vSolInBondingCurve: number | undefined,
    vTokensInBondingCurve: number | undefined,
    amountTokens: number,
    feeRate: number = PUMP_FEE_RATE
): PumpSellSimulation | null {
    if (!Number.isFinite(amountTokens) || amountTokens <= 0) return null;
    if (!Number.isFinite(vSolInBondingCurve) || !vSolInBondingCurve || vSolInBondingCurve <= 0) return null;
    const vTokens = normalizePumpVirtualTokens(vTokensInBondingCurve);
    if (vTokens <= 0) return null;
    if (amountTokens >= vTokens) return null;

    const safeFee = clamp(feeRate, 0, 0.05);
    const k = vSolInBondingCurve * vTokens;
    const newVTokens = vTokens + amountTokens;
    const newVSol = k / newVTokens;
    const solOutGross = Math.max(0, vSolInBondingCurve - newVSol);
    if (solOutGross <= 0) return null;

    const feeSol = solOutGross * safeFee;
    const solOut = solOutGross - feeSol;

    return {
        solOut,
        effectivePrice: solOut / amountTokens,
        newVSol,
        newVTokens,
        feeSol
    };
}
