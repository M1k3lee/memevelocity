import type { ManagedExitStrategy } from './tradeExit';

export const PAPER_BASE_TX_FEE_SOL = 0.00001;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
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
    const sideFactor = side === 'buy' ? 0.14 : 0.18;
    const fastFactor = fastTrade ? 1.2 : 1;
    const fillPenaltyPercent = clamp(
        (requestedSlippagePercent * sideFactor * sizeFactor * fastFactor) + (fastTrade ? 0.25 : 0.1),
        0.25,
        fastTrade ? 3.25 : 2.2
    );
    const multiplier = side === 'buy'
        ? 1 + (fillPenaltyPercent / 100)
        : Math.max(0, 1 - (fillPenaltyPercent / 100));

    return observedPrice * multiplier;
}
