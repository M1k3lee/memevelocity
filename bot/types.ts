import type { AdvancedConfig } from '../utils/enhancedAnalyzer';

export type BotMode = 'runner' | 'sniper' | 'degen' | 'god' | 'safe' | 'medium' | 'high' | 'velocity' | 'first' | 'scalp';

export interface ManagedExitStrategy {
    takeProfit: number;
    takeProfit2?: number;
    stopLoss: number;
    maxHoldTime: number;
    trailingStop: boolean;
    trailingStopPercent?: number;
    momentumExit?: boolean;
    minHoldTime?: number;
}

export interface ManagedPosition {
    mint: string;
    symbol: string;
    status: 'open' | 'selling' | 'closed';
    buyPrice: number;
    currentPrice: number;
    highestPrice: number;
    amountTokens: number;
    amountSolPaid: number;
    buyTime: number;
    txId?: string;
    lastPriceUpdate?: number;
    lastLiquidity?: number;
    partialSells: Record<string, boolean>;
    realizedProfitSol: number;
    totalRevenueSol: number;
    analysisScore?: number;
    analysisRisk?: string;
    analysisReasons?: string[];
    exitStrategy: ManagedExitStrategy;
    closeReason?: string;
    closeTime?: number;
}

export interface BotStateTotals {
    realizedProfitSol: number;
    wins: number;
    losses: number;
    trades: number;
}

export interface BotState {
    version: number;
    walletAddress: string | null;
    startedAt: number;
    updatedAt: number;
    totals: BotStateTotals;
    openPositions: ManagedPosition[];
    closedPositions: ManagedPosition[];
    logs: string[];
}

export interface RunnerConfig {
    dryRun: boolean;
    heliusKey: string;
    walletAddress: string | null;
    walletSecret: string;
    mode: BotMode;
    amountSol: number;
    slippage: number;
    maxConcurrentTrades: number;
    minTimeBetweenTradesMs: number;
    dynamicSizing: boolean;
    minBalanceReserveSol: number;
    analysisCooldownMs: number;
    healthLogIntervalMs: number;
    pricePollIntervalMs: number;
    maxTrackedMints: number;
    statePath: string;
    advanced: AdvancedConfig;
    defaultExit: ManagedExitStrategy;
}
