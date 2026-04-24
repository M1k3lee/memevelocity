import type { ManagedExitStrategy } from './tradeExit';
import {
    estimatePaperFillPrice,
    simulatePaperBuy,
    simulatePaperSell,
    PAPER_BASE_TX_FEE_SOL,
    PUMP_FEE_RATE
} from './executionModel';

export const PAPER_TOKEN_ACCOUNT_RENT_SOL = 0.00204;
export { PUMP_FEE_RATE };

export type PaperCurveState = {
    vSolInBondingCurve?: number;
    vTokensInBondingCurve?: number;
};

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

/**
 * Simulate a paper buy that mirrors live fill economics. Pass the live pump.fun
 * curve state (`curve`) whenever it's available — that enables real AMM math.
 * When omitted, falls back to the heuristic but now including the 1% protocol
 * fee and confirmation drift.
 */
export function estimatePaperBuyExecution(params: {
    observedPrice: number;
    amountSol: number;
    requestedSlippagePercent: number;
    exitStrategy?: Pick<ManagedExitStrategy, 'maxHoldTime'> | null;
    curve?: PaperCurveState | null;
}) {
    const { observedPrice, amountSol, requestedSlippagePercent, exitStrategy, curve } = params;
    const sim = simulatePaperBuy({
        observedPrice,
        amountSol,
        requestedSlippagePercent,
        exitStrategy,
        curve
    });

    return {
        fillPrice: sim.fillPrice,
        tokensOut: sim.tokensOut,
        networkFeeSol: sim.networkFeeSol,
        protocolFeeSol: sim.protocolFeeSol,
        newVSol: sim.newVSol,
        newVTokens: sim.newVTokens
    };
}

/**
 * Simulate a paper sell mirroring live fill economics. `failureSeed` enables
 * deterministic retry modelling (`${mint}:${buyTime}:${stage}` is a good seed).
 */
export function estimatePaperSellExecution(params: {
    observedPrice: number;
    amountSolPaid: number;
    amountTokens: number;
    exitStrategy?: Pick<ManagedExitStrategy, 'maxHoldTime'> | null;
    curve?: PaperCurveState | null;
    failureSeed?: string;
}) {
    const { observedPrice, amountSolPaid, amountTokens, exitStrategy, curve, failureSeed } = params;
    const sim = simulatePaperSell({
        observedPrice,
        amountSolPaid,
        amountTokens,
        exitStrategy,
        curve,
        failureSeed
    });

    return {
        fillPrice: sim.fillPrice,
        networkFeeSol: sim.networkFeeSol,
        netProceedsSol: sim.netProceedsSol,
        protocolFeeSol: sim.protocolFeeSol,
        retried: sim.retried,
        newVSol: sim.newVSol,
        newVTokens: sim.newVTokens
    };
}
