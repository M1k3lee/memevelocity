const PUMP_TOKEN_DECIMALS = 1_000_000;
const PUMP_RAW_TOKEN_THRESHOLD = 10_000_000_000;
const PUMP_INITIAL_VIRTUAL_TOKENS = 1_073_000_000;
const PUMP_CURVE_SALE_TOKENS = 793_100_000;

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
