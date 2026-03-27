import type { ManagedExitStrategy } from './tradeExit';
import {
    estimatePaperFillPrice,
    getLiveBuyExecutionPlan,
    getLiveSellExecutionPlan,
    PAPER_BASE_TX_FEE_SOL
} from './executionModel';

export const PAPER_TOKEN_ACCOUNT_RENT_SOL = 0.00204;

export function getPaperEntryPrice(observedPrice: number): number {
    return estimatePaperFillPrice({
        observedPrice,
        side: 'buy',
        requestedSlippagePercent: 15,
        amountSol: 0.01
    });
}

export function getPaperExitPrice(observedPrice: number): number {
    return estimatePaperFillPrice({
        observedPrice,
        side: 'sell',
        requestedSlippagePercent: 25,
        amountSol: 0.01
    });
}

export function estimatePaperBuyExecution(params: {
    observedPrice: number;
    amountSol: number;
    requestedSlippagePercent: number;
    exitStrategy?: Pick<ManagedExitStrategy, 'maxHoldTime'> | null;
}) {
    const { observedPrice, amountSol, requestedSlippagePercent, exitStrategy } = params;
    const executionPlan = getLiveBuyExecutionPlan(amountSol, requestedSlippagePercent, exitStrategy);
    const fillPrice = estimatePaperFillPrice({
        observedPrice,
        side: 'buy',
        requestedSlippagePercent: executionPlan.initialSlippagePercent,
        amountSol,
        exitStrategy
    });

    return {
        fillPrice,
        networkFeeSol: PAPER_BASE_TX_FEE_SOL + executionPlan.initialPriorityFeeSol
    };
}

export function estimatePaperSellExecution(params: {
    observedPrice: number;
    amountSolPaid: number;
    amountTokens: number;
    exitStrategy?: Pick<ManagedExitStrategy, 'maxHoldTime'> | null;
}) {
    const { observedPrice, amountSolPaid, amountTokens, exitStrategy } = params;
    const executionPlan = getLiveSellExecutionPlan(amountSolPaid, exitStrategy);
    const fillPrice = estimatePaperFillPrice({
        observedPrice,
        side: 'sell',
        requestedSlippagePercent: executionPlan.primarySlippagePercent,
        amountSol: amountSolPaid,
        exitStrategy
    });
    const networkFeeSol = PAPER_BASE_TX_FEE_SOL + executionPlan.priorityFeeSol;
    const grossProceedsSol = amountTokens * fillPrice;

    return {
        fillPrice,
        networkFeeSol,
        netProceedsSol: Math.max(0, grossProceedsSol - networkFeeSol)
    };
}
