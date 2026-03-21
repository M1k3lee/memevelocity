const DEFAULT_FEE_RESERVE_SOL = 0.02;
const MICRO_WALLET_THRESHOLD_SOL = 0.05;
const MICRO_WALLET_RESERVE_FLOOR_SOL = 0.008;
const MICRO_WALLET_RESERVE_RATIO = 0.28;

export function getAdaptiveFeeReserve(balanceSol?: number | null): number {
    if (balanceSol === null || balanceSol === undefined || !Number.isFinite(balanceSol) || balanceSol <= 0) {
        return DEFAULT_FEE_RESERVE_SOL;
    }

    if (balanceSol > MICRO_WALLET_THRESHOLD_SOL) {
        return DEFAULT_FEE_RESERVE_SOL;
    }

    const scaledReserve = balanceSol * MICRO_WALLET_RESERVE_RATIO;
    return Number(Math.max(MICRO_WALLET_RESERVE_FLOOR_SOL, Math.min(DEFAULT_FEE_RESERVE_SOL, scaledReserve)).toFixed(4));
}

export function fitTradeAmountToBalance(requestedAmountSol: number, balanceSol?: number | null) {
    const reserveSol = getAdaptiveFeeReserve(balanceSol);
    const safeBalance = balanceSol ?? 0;
    const spendableSol = Math.max(0, safeBalance - reserveSol);
    const fittedAmountSol = Number(Math.max(0, Math.min(requestedAmountSol, spendableSol)).toFixed(4));

    return {
        reserveSol,
        spendableSol: Number(spendableSol.toFixed(4)),
        fittedAmountSol,
        adjusted: fittedAmountSol < requestedAmountSol
    };
}
