import type { EnhancedAnalysis } from '../utils/enhancedAnalyzer';
import { estimatePaperBuyExecution, estimatePaperSellExecution, PAPER_TOKEN_ACCOUNT_RENT_SOL } from '../utils/paperTrading';
import {
    clearAllMarketSnapshots,
    getMarketSnapshot,
    recordMarketEvent
} from '../utils/marketData';
import { calculatePumpPrice } from '../utils/pumpMath';
import { evaluateLiveEntryGuard } from '../utils/liveEntryGuard';
import type { ManagedExitStrategy, PartialSellFlags } from '../utils/tradeExit';
import {
    getProfitLockFloor,
    getRunnerActivationProfit,
    getRunnerMaxHoldTime,
    getRunnerTimeExitFloor,
    getRunnerTrailingStopPercent,
    getTp1SellPercent,
    getTp2SellPercent,
    hasTp1Sell,
    hasTp2Sell
} from '../utils/tradeExit';
import type { TokenData } from '../types/token';

const PUMP_INITIAL_VIRTUAL_TOKENS = 1_073_000_000;
const PUMP_CURVE_SALE_TOKENS = 793_100_000;

const LEGACY_EXIT: ManagedExitStrategy = {
    takeProfit: 30,
    takeProfit2: 95,
    stopLoss: 5,
    maxHoldTime: 240,
    trailingStop: false,
    fastKillLoss: 2.8,
    fastKillSeconds: 6,
    givebackPeakTrigger: 7,
    givebackFloor: 1.5,
    givebackSeconds: 14,
    stagnationSeconds: 60,
    stagnationFloor: 2,
    tp1SellPercent: 70,
    tp2SellPercent: 15,
    postTp1FloorPercent: 4,
    postTp2FloorPercent: 14,
    runnerMaxHoldTime: 900,
    runnerTrailingStopPercent: 18,
    runnerActivationProfit: 30,
    runnerTimeExitFloor: 12
};

const STRICT_EXIT: ManagedExitStrategy = {
    takeProfit: 24,
    takeProfit2: 55,
    stopLoss: 4.5,
    maxHoldTime: 180,
    trailingStop: false,
    fastKillLoss: 2.5,
    fastKillSeconds: 6,
    givebackPeakTrigger: 6,
    givebackFloor: 1.5,
    givebackSeconds: 15,
    stagnationSeconds: 35,
    stagnationFloor: 2,
    tp1SellPercent: 75,
    tp2SellPercent: 15,
    postTp1FloorPercent: 4,
    postTp2FloorPercent: 10,
    runnerMaxHoldTime: 420,
    runnerTrailingStopPercent: 14,
    runnerActivationProfit: 25,
    runnerTimeExitFloor: 6
};

const AGGRESSIVE_EXIT: ManagedExitStrategy = {
    takeProfit: 8,
    takeProfit2: 14,
    stopLoss: 4,
    maxHoldTime: 40,
    trailingStop: false,
    fastKillLoss: 2.2,
    fastKillSeconds: 5,
    givebackPeakTrigger: 3.2,
    givebackFloor: 0.2,
    givebackSeconds: 6,
    stagnationSeconds: 10,
    stagnationFloor: -0.5,
    tp1SellPercent: 82,
    tp2SellPercent: 8,
    postTp1FloorPercent: 1,
    postTp2FloorPercent: 3,
    runnerMaxHoldTime: 90,
    runnerTrailingStopPercent: 6,
    runnerActivationProfit: 8,
    runnerTimeExitFloor: 2
};

const PROBE_EXIT: ManagedExitStrategy = {
    takeProfit: 8,
    takeProfit2: 14,
    stopLoss: 4,
    maxHoldTime: 30,
    trailingStop: false,
    fastKillLoss: 2.2,
    fastKillSeconds: 4,
    givebackPeakTrigger: 3.2,
    givebackFloor: 0.4,
    givebackSeconds: 7,
    stagnationSeconds: 12,
    stagnationFloor: -0.5,
    tp1SellPercent: 85,
    tp2SellPercent: 10,
    postTp1FloorPercent: 1.2,
    postTp2FloorPercent: 4,
    runnerMaxHoldTime: 90,
    runnerTrailingStopPercent: 8,
    runnerActivationProfit: 8,
    runnerTimeExitFloor: 2
};

type ScenarioEvent = {
    t: number;
    txType: TokenData['txType'];
    trader: string;
    liquiditySol: number;
    progress: number;
    initialBuy?: number;
};

type Scenario = {
    id: string;
    description: string;
    creator: string;
    quality: {
        holderCount: number;
        deployerHoldings: number;
        top10Concentration: number;
    };
    events: ScenarioEvent[];
};

type Position = {
    buyPrice: number;
    amountTokens: number;
    amountSolPaid: number;
    currentPrice: number;
    highestPrice: number;
    buyTime: number;
    partialSells: Record<string, boolean>;
    exitStrategy: ManagedExitStrategy;
    entryAgeSeconds: number;
};

type StrategyName = 'legacy' | 'strict' | 'aggressive' | 'probe';

type StrategyConfig = {
    name: StrategyName;
    label: string;
    amountSol: number;
    buySlippagePercent: number;
    exitStrategy: ManagedExitStrategy;
    guardMode?: 'god' | 'degen' | 'sniper';
    useLegacyEntry?: boolean;
};

type RunResult = {
    strategy: StrategyName;
    entered: boolean;
    entryAgeSeconds?: number;
    realizedPnlSol: number;
    closeReason: string;
};

const STRATEGIES: StrategyConfig[] = [
    {
        name: 'legacy',
        label: 'legacy',
        amountSol: 0.006,
        buySlippagePercent: 12,
        exitStrategy: LEGACY_EXIT,
        useLegacyEntry: true
    },
    {
        name: 'strict',
        label: 'strict',
        amountSol: 0.006,
        buySlippagePercent: 12,
        exitStrategy: STRICT_EXIT,
        guardMode: 'god'
    },
    {
        name: 'aggressive',
        label: 'aggressive',
        amountSol: 0.0025,
        buySlippagePercent: 12,
        exitStrategy: AGGRESSIVE_EXIT,
        guardMode: 'degen'
    },
    {
        name: 'probe',
        label: 'probe',
        amountSol: 0.002,
        buySlippagePercent: 12,
        exitStrategy: PROBE_EXIT,
        guardMode: 'sniper'
    }
];

function vTokensFromProgress(progress: number): number {
    return Math.max(1, PUMP_INITIAL_VIRTUAL_TOKENS - ((progress / 100) * PUMP_CURVE_SALE_TOKENS));
}

function makeToken(scenario: Scenario, mint: string, event: ScenarioEvent, launchTime: number, now: number): TokenData {
    return {
        mint,
        traderPublicKey: event.trader,
        creatorPublicKey: scenario.creator,
        txType: event.txType,
        initialBuy: event.initialBuy || 0,
        bondingCurveKey: `${mint}-curve`,
        vTokensInBondingCurve: vTokensFromProgress(event.progress),
        vSolInBondingCurve: event.liquiditySol,
        marketCapSol: event.liquiditySol,
        name: scenario.id,
        symbol: scenario.id.slice(0, 6).toUpperCase(),
        uri: '',
        timestamp: now,
        createdAt: launchTime,
        lastSeenAt: now
    };
}

function buildAnalysis(token: TokenData, quality: Scenario['quality']): EnhancedAnalysis {
    const snapshot = getMarketSnapshot(token.mint);
    const age = Math.max(0, (Date.now() - (token.createdAt || token.timestamp)) / 1000);
    const bondingCurveProgress = token.vTokensInBondingCurve > 0
        ? Math.max(0, Math.min(100, ((PUMP_INITIAL_VIRTUAL_TOKENS - token.vTokensInBondingCurve) / PUMP_CURVE_SALE_TOKENS) * 100))
        : 0;

    return {
        score: 82,
        riskLevel: 'low',
        passed: true,
        reasons: [],
        warnings: [],
        strengths: [],
        bondingCurveProgress,
        marketCap: token.vSolInBondingCurve,
        tiers: {
            tier0: 100,
            tier1: 8,
            tier2: 80,
            tier3: 10,
            tier4: 65,
            totalScore: 263
        },
        metrics: {
            holderCount: quality.holderCount,
            deployerHoldings: quality.deployerHoldings,
            top10Concentration: quality.top10Concentration,
            observedVolume: snapshot?.observedVolumeSol || 0,
            buyPressure: snapshot?.buyPressure || 0,
            bondingCurveVelocity: age > 0 ? (bondingCurveProgress / age) * 60 : 0,
            liquidityDepth: token.vSolInBondingCurve,
            tradeCount: snapshot?.tradeCount || 0,
            uniqueTraderCount: snapshot?.uniqueTraderCount || 0,
            priceChangePercent: snapshot?.priceChangePercent || 0,
            largestTraderVolumeShare: snapshot?.largestTraderVolumeShare || 0,
            topTwoTraderVolumeShare: snapshot?.topTwoTraderVolumeShare || 0,
            creatorVolumeShare: snapshot?.creatorVolumeShare || 0,
            creatorBuyCount: snapshot?.creatorBuyCount || 0,
            creatorSellCount: snapshot?.creatorSellCount || 0,
            contractSecurity: {
                freezeAuthority: true,
                mintAuthority: true,
                updateAuthority: true
            }
        }
    };
}

function calculateLegacyRunnerScore(params: {
    age: number;
    observedVolume: number;
    tradeCount: number;
    uniqueTraderCount: number;
    buyPressure: number;
    bondingCurveProgress: number;
    netFlow: number;
    priceChangePercent: number;
    stressImpactPercent: number;
    top10Concentration: number;
    creatorHoldings: number;
}): number {
    const {
        age,
        observedVolume,
        tradeCount,
        uniqueTraderCount,
        buyPressure,
        bondingCurveProgress,
        netFlow,
        priceChangePercent,
        stressImpactPercent,
        top10Concentration,
        creatorHoldings
    } = params;

    const capitalEfficiency = observedVolume / Math.max(1, tradeCount);
    const traderDiversity = Math.min(1, uniqueTraderCount / Math.max(1, tradeCount));
    const curveVelocity = age > 0 ? (bondingCurveProgress / age) * 60 : 0;
    const flowVelocity = age > 0 ? (netFlow / age) * 60 : 0;
    let score = 28;

    if (age >= 8 && age <= 90) score += 10;
    else if (age > 120) score -= 10;

    if (observedVolume >= 1.5) score += 16;
    else if (observedVolume >= 1.0) score += 10;
    else score -= 14;

    if (capitalEfficiency >= 0.12) score += 14;
    else if (capitalEfficiency >= 0.09) score += 8;
    else score -= 12;

    if (buyPressure >= 0.66) score += 12;
    else if (buyPressure >= 0.58) score += 7;
    else score -= 12;

    if (uniqueTraderCount >= 8) score += 10;
    else if (uniqueTraderCount >= 6) score += 5;
    else score -= 10;

    if (traderDiversity >= 0.5) score += 10;
    else if (traderDiversity >= 0.42) score += 5;
    else score -= 8;

    if (curveVelocity >= 0.9) score += 10;
    else if (curveVelocity >= 0.65) score += 6;
    else score -= 10;

    if (flowVelocity >= 0.45) score += 8;
    else if (flowVelocity < 0.2) score -= 8;

    if (priceChangePercent >= 1 && priceChangePercent <= 10) score += 6;
    else if (priceChangePercent > 14 || priceChangePercent < -2) score -= 10;

    if (stressImpactPercent <= 1.8) score += 8;
    else if (stressImpactPercent <= 2.4) score += 4;
    else score -= 14;

    if (top10Concentration > 0) {
        if (top10Concentration <= 22) score += 10;
        else if (top10Concentration > 28) score -= 12;
    }

    if (creatorHoldings >= 0) {
        if (creatorHoldings <= 4) score += 8;
        else if (creatorHoldings > 8) score -= 12;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
}

function evaluateLegacyRunnerEntry(token: TokenData, analysis: EnhancedAnalysis, amountSol: number): boolean {
    const snapshot = getMarketSnapshot(token.mint);
    const age = Math.max(0, (Date.now() - (token.createdAt || token.timestamp)) / 1000);
    const liquidity = token.vSolInBondingCurve || analysis.marketCap || 30;
    const liquidityGrowth = liquidity - 30;
    const tradeCount = snapshot?.tradeCount || analysis.metrics.tradeCount || 0;
    const sellCount = snapshot?.sellCount || 0;
    const uniqueTraderCount = snapshot?.uniqueTraderCount || analysis.metrics.uniqueTraderCount || 0;
    const observedVolume = snapshot?.observedVolumeSol || analysis.metrics.observedVolume || 0;
    const buyPressure = snapshot?.buyPressure ?? analysis.metrics.buyPressure ?? 0;
    const netFlow = snapshot?.netFlowSol || 0;
    const priceChangePercent = snapshot?.priceChangePercent || analysis.metrics.priceChangePercent || 0;
    const impact = liquidity > 0 ? (amountSol / liquidity) * 100 : 100;

    if (sellCount > Math.max(2, Math.floor(tradeCount * 0.45)) && age <= 90) return false;
    if (netFlow <= 0 && age >= 20) return false;

    const waitingOnSnapshot =
        age <= 45 &&
        tradeCount === 0 &&
        uniqueTraderCount <= 1 &&
        observedVolume <= 0.25 &&
        liquidityGrowth > 0.25;
    if (waitingOnSnapshot) return false;

    if (impact > 1.8) return false;

    if (
        tradeCount < 8 ||
        uniqueTraderCount < 6 ||
        observedVolume < 1.25 ||
        buyPressure < 0.6
    ) {
        return false;
    }

    const score = calculateLegacyRunnerScore({
        age,
        observedVolume,
        tradeCount,
        uniqueTraderCount,
        buyPressure,
        bondingCurveProgress: analysis.bondingCurveProgress,
        netFlow,
        priceChangePercent,
        stressImpactPercent: impact,
        top10Concentration: analysis.metrics.top10Concentration,
        creatorHoldings: analysis.metrics.deployerHoldings
    });

    return score >= 74;
}

function executeSell(position: Position, amountPercent: number, price: number): { realizedDelta: number; closed: boolean } {
    const sellFraction = Math.max(0, Math.min(100, amountPercent)) / 100;
    const soldTokenAmount = position.amountTokens * sellFraction;
    const costBasis = position.buyPrice * soldTokenAmount;
    const sellExecution = estimatePaperSellExecution({
        observedPrice: price,
        amountSolPaid: position.amountSolPaid * sellFraction,
        amountTokens: soldTokenAmount,
        exitStrategy: position.exitStrategy
    });
    const realizedDelta = sellExecution.netProceedsSol - costBasis;

    position.amountTokens = Math.max(0, position.amountTokens - soldTokenAmount);
    position.amountSolPaid = Math.max(0, position.amountSolPaid * (1 - sellFraction));

    if (amountPercent >= 99 || position.amountTokens <= 0.0000001) {
        return {
            realizedDelta,
            closed: true
        };
    }

    return {
        realizedDelta,
        closed: false
    };
}

function maybeManageExit(position: Position, price: number, now: number): { closeReason?: string; realizedDelta?: number; closed?: boolean } {
    position.currentPrice = price;
    position.highestPrice = Math.max(position.highestPrice, price);

    const holdTimeSeconds = Math.max(0, (now - position.buyTime) / 1000);
    const currentPnl = position.buyPrice > 0 ? ((price - position.buyPrice) / position.buyPrice) * 100 : 0;
    const peakPnl = position.highestPrice > position.buyPrice
        ? ((position.highestPrice - position.buyPrice) / position.buyPrice) * 100
        : currentPnl;

    const strategy = position.exitStrategy;
    const runnerActive = hasTp1Sell(position.partialSells);
    const profitLockFloor = getProfitLockFloor(strategy, position.partialSells as PartialSellFlags);
    const runnerMaxHoldTime = getRunnerMaxHoldTime(strategy, position.partialSells as PartialSellFlags);

    if (runnerMaxHoldTime && holdTimeSeconds >= runnerMaxHoldTime) {
        const runnerTimeExitFloor = getRunnerTimeExitFloor(strategy);
        if (currentPnl < runnerTimeExitFloor) {
            const sell = executeSell(position, 100, price);
            return { closeReason: 'runner-time-exit', realizedDelta: sell.realizedDelta, closed: sell.closed };
        }
    } else if (!runnerActive && strategy.maxHoldTime && holdTimeSeconds >= strategy.maxHoldTime && currentPnl < 10) {
        const sell = executeSell(position, 100, price);
        return { closeReason: 'time-exit', realizedDelta: sell.realizedDelta, closed: sell.closed };
    }

    if (!runnerActive && strategy.fastKillSeconds && strategy.fastKillLoss !== undefined && holdTimeSeconds >= strategy.fastKillSeconds && currentPnl <= -Math.abs(strategy.fastKillLoss)) {
        const sell = executeSell(position, 100, price);
        return { closeReason: 'fast-kill', realizedDelta: sell.realizedDelta, closed: sell.closed };
    }

    if (!runnerActive && strategy.givebackSeconds && strategy.givebackPeakTrigger !== undefined && strategy.givebackFloor !== undefined) {
        if (holdTimeSeconds >= strategy.givebackSeconds && peakPnl >= strategy.givebackPeakTrigger && currentPnl <= strategy.givebackFloor) {
            const sell = executeSell(position, 100, price);
            return { closeReason: 'giveback-exit', realizedDelta: sell.realizedDelta, closed: sell.closed };
        }
    }

    if (!runnerActive && strategy.stagnationSeconds && strategy.stagnationFloor !== undefined && holdTimeSeconds >= strategy.stagnationSeconds) {
        const peakTrigger = strategy.givebackPeakTrigger ?? 4;
        if (peakPnl < peakTrigger && currentPnl <= strategy.stagnationFloor) {
            const sell = executeSell(position, 100, price);
            return { closeReason: 'stagnation-exit', realizedDelta: sell.realizedDelta, closed: sell.closed };
        }
    }

    if (profitLockFloor !== null && currentPnl <= profitLockFloor) {
        const sell = executeSell(position, 100, price);
        return { closeReason: 'profit-lock', realizedDelta: sell.realizedDelta, closed: sell.closed };
    }

    const runnerTrailingStopPercent = getRunnerTrailingStopPercent(strategy, position.partialSells as PartialSellFlags);
    if (runnerTrailingStopPercent !== null && position.highestPrice > position.buyPrice) {
        const currentDropFromPeak = ((position.highestPrice - price) / position.highestPrice) * 100;
        if (peakPnl >= getRunnerActivationProfit(strategy) && currentDropFromPeak >= runnerTrailingStopPercent) {
            const sell = executeSell(position, 100, price);
            return { closeReason: 'runner-trailing-stop', realizedDelta: sell.realizedDelta, closed: sell.closed };
        }
    }

    if (currentPnl <= -Math.abs(strategy.stopLoss)) {
        const sell = executeSell(position, 100, price);
        return { closeReason: 'stop-loss', realizedDelta: sell.realizedDelta, closed: sell.closed };
    }

    if (currentPnl >= strategy.takeProfit && !hasTp1Sell(position.partialSells as PartialSellFlags)) {
        const sell = executeSell(position, getTp1SellPercent(strategy), price);
        position.partialSells.tp1 = true;
        return { closeReason: 'tp1', realizedDelta: sell.realizedDelta, closed: sell.closed };
    }

    if (strategy.takeProfit2 && currentPnl >= strategy.takeProfit2 && !hasTp2Sell(position.partialSells as PartialSellFlags)) {
        const sell = executeSell(position, getTp2SellPercent(strategy), price);
        position.partialSells.tp2 = true;
        return { closeReason: 'tp2', realizedDelta: sell.realizedDelta, closed: sell.closed };
    }

    return {};
}

function getStrategyConfig(strategy: StrategyName): StrategyConfig {
    const config = STRATEGIES.find((item) => item.name === strategy);
    if (!config) {
        throw new Error(`Unknown replay strategy: ${strategy}`);
    }

    return config;
}

function runScenario(strategy: StrategyName, scenario: Scenario): RunResult {
    clearAllMarketSnapshots();

    const originalDateNow = Date.now;
    const replayStart = originalDateNow();
    const launchTime = replayStart;
    const mint = `${scenario.id}-mint`;
    const strategyConfig = getStrategyConfig(strategy);
    const exitStrategy = strategyConfig.exitStrategy;
    let position: Position | null = null;
    let entryAgeSeconds: number | undefined;
    let realizedPnlSol = 0;
    let closeReason = 'no-entry';

    try {
        for (const event of scenario.events) {
            const now = replayStart + (event.t * 1000);
            Date.now = () => now;

            const token = makeToken(scenario, mint, event, launchTime, now);
            recordMarketEvent(token);
            const price = calculatePumpPrice(token.vSolInBondingCurve, token.vTokensInBondingCurve);

            if (!position) {
                const analysis = buildAnalysis(token, scenario.quality);
                const shouldEnter = strategyConfig.useLegacyEntry
                    ? evaluateLegacyRunnerEntry(token, analysis, strategyConfig.amountSol)
                    : evaluateLiveEntryGuard(strategyConfig.guardMode || 'god', token, analysis, strategyConfig.amountSol).status === 'pass';

                if (shouldEnter && price > 0) {
                    const buyExecution = estimatePaperBuyExecution({
                        observedPrice: price,
                        amountSol: strategyConfig.amountSol,
                        requestedSlippagePercent: strategyConfig.buySlippagePercent,
                        exitStrategy
                    });
                    const tradeableSol = strategyConfig.amountSol - PAPER_TOKEN_ACCOUNT_RENT_SOL;
                    const amountTokens = tradeableSol / buyExecution.fillPrice;

                    position = {
                        buyPrice: buyExecution.fillPrice,
                        amountTokens,
                        amountSolPaid: strategyConfig.amountSol + buyExecution.networkFeeSol,
                        currentPrice: buyExecution.fillPrice,
                        highestPrice: buyExecution.fillPrice,
                        buyTime: now,
                        partialSells: {},
                        exitStrategy,
                        entryAgeSeconds: event.t
                    };
                    entryAgeSeconds = event.t;
                    closeReason = 'open';
                }
            }

            if (position && price > 0) {
                const sellResult = maybeManageExit(position, price, now);
                if (sellResult.realizedDelta) {
                    realizedPnlSol += sellResult.realizedDelta;
                }
                if (sellResult.closed) {
                    closeReason = sellResult.closeReason || 'closed';
                    position = null;
                }
            }
        }

        if (position) {
            const lastEvent = scenario.events[scenario.events.length - 1];
            const now = replayStart + (lastEvent.t * 1000);
            Date.now = () => now;
            const lastPrice = calculatePumpPrice(lastEvent.liquiditySol, vTokensFromProgress(lastEvent.progress));
            const sell = executeSell(position, 100, lastPrice);
            realizedPnlSol += sell.realizedDelta;
            closeReason = 'forced-close';
        }
    } finally {
        Date.now = originalDateNow;
        clearAllMarketSnapshots();
    }

    return {
        strategy,
        entered: closeReason !== 'no-entry',
        entryAgeSeconds,
        realizedPnlSol,
        closeReason
    };
}

const scenarios: Scenario[] = [
    {
        id: 'organic',
        description: 'Diversified follow-through, small shakeout, then trend continuation.',
        creator: 'creator-organic',
        quality: { holderCount: 34, deployerHoldings: 2.4, top10Concentration: 18 },
        events: [
            { t: 0, txType: 'create', trader: 'creator-organic', liquiditySol: 30.35, progress: 0.5, initialBuy: 0.35 },
            { t: 6, txType: 'buy', trader: 'w1', liquiditySol: 30.7, progress: 0.9 },
            { t: 10, txType: 'buy', trader: 'w2', liquiditySol: 31.1, progress: 1.4 },
            { t: 14, txType: 'sell', trader: 'w3', liquiditySol: 30.95, progress: 1.3 },
            { t: 19, txType: 'buy', trader: 'w4', liquiditySol: 31.55, progress: 2.1 },
            { t: 25, txType: 'buy', trader: 'w5', liquiditySol: 32.2, progress: 3.0 },
            { t: 32, txType: 'buy', trader: 'w6', liquiditySol: 33.0, progress: 4.1 },
            { t: 42, txType: 'sell', trader: 'w7', liquiditySol: 32.8, progress: 3.9 },
            { t: 55, txType: 'buy', trader: 'w8', liquiditySol: 34.0, progress: 5.3 },
            { t: 75, txType: 'buy', trader: 'w9', liquiditySol: 36.9, progress: 8.8 },
            { t: 110, txType: 'buy', trader: 'w10', liquiditySol: 40.8, progress: 13.4 },
            { t: 145, txType: 'sell', trader: 'w11', liquiditySol: 39.6, progress: 11.8 }
        ]
    },
    {
        id: 'breakout',
        description: 'Clean second-wave continuation that should pay the conservative runner quickly.',
        creator: 'creator-breakout',
        quality: { holderCount: 42, deployerHoldings: 2.1, top10Concentration: 17 },
        events: [
            { t: 0, txType: 'create', trader: 'creator-breakout', liquiditySol: 30.32, progress: 0.4, initialBuy: 0.32 },
            { t: 5, txType: 'buy', trader: 'w1', liquiditySol: 30.72, progress: 0.9 },
            { t: 9, txType: 'buy', trader: 'w2', liquiditySol: 31.08, progress: 1.3 },
            { t: 13, txType: 'sell', trader: 'w3', liquiditySol: 30.92, progress: 1.1 },
            { t: 17, txType: 'buy', trader: 'w4', liquiditySol: 31.55, progress: 2.0 },
            { t: 22, txType: 'buy', trader: 'w5', liquiditySol: 32.25, progress: 3.0 },
            { t: 28, txType: 'buy', trader: 'w6', liquiditySol: 33.15, progress: 4.2 },
            { t: 35, txType: 'sell', trader: 'w7', liquiditySol: 32.95, progress: 3.9 },
            { t: 46, txType: 'buy', trader: 'w8', liquiditySol: 35.1, progress: 6.8 },
            { t: 60, txType: 'buy', trader: 'w9', liquiditySol: 38.6, progress: 10.4 },
            { t: 78, txType: 'buy', trader: 'w10', liquiditySol: 44.8, progress: 17.8 },
            { t: 105, txType: 'sell', trader: 'w11', liquiditySol: 43.2, progress: 15.9 }
        ]
    },
    {
        id: 'dominated',
        description: 'Looks active, but most early flow is concentrated in two wallets before the dump.',
        creator: 'creator-dominated',
        quality: { holderCount: 18, deployerHoldings: 3.1, top10Concentration: 23 },
        events: [
            { t: 0, txType: 'create', trader: 'creator-dominated', liquiditySol: 30.3, progress: 0.4, initialBuy: 0.3 },
            { t: 6, txType: 'buy', trader: 'whale-1', liquiditySol: 30.95, progress: 1.1 },
            { t: 10, txType: 'buy', trader: 'whale-1', liquiditySol: 31.55, progress: 1.9 },
            { t: 14, txType: 'buy', trader: 'whale-2', liquiditySol: 32.25, progress: 2.9 },
            { t: 18, txType: 'buy', trader: 'whale-1', liquiditySol: 33.05, progress: 4.1 },
            { t: 20, txType: 'buy', trader: 'w3', liquiditySol: 33.15, progress: 4.2 },
            { t: 23, txType: 'buy', trader: 'w4', liquiditySol: 33.25, progress: 4.3 },
            { t: 26, txType: 'buy', trader: 'w5', liquiditySol: 33.35, progress: 4.4 },
            { t: 29, txType: 'buy', trader: 'w6', liquiditySol: 33.45, progress: 4.5 },
            { t: 40, txType: 'sell', trader: 'whale-1', liquiditySol: 31.6, progress: 2.7 },
            { t: 55, txType: 'sell', trader: 'whale-2', liquiditySol: 30.7, progress: 1.0 }
        ]
    },
    {
        id: 'onesided',
        description: 'Many wallets print buys, but no shakeout ever comes and the tape air-pockets.',
        creator: 'creator-onesided',
        quality: { holderCount: 22, deployerHoldings: 2.8, top10Concentration: 21 },
        events: [
            { t: 0, txType: 'create', trader: 'creator-onesided', liquiditySol: 30.25, progress: 0.3, initialBuy: 0.25 },
            { t: 5, txType: 'buy', trader: 'w1', liquiditySol: 30.6, progress: 0.8 },
            { t: 9, txType: 'buy', trader: 'w2', liquiditySol: 30.95, progress: 1.2 },
            { t: 12, txType: 'buy', trader: 'w3', liquiditySol: 31.35, progress: 1.8 },
            { t: 16, txType: 'buy', trader: 'w4', liquiditySol: 31.8, progress: 2.5 },
            { t: 20, txType: 'buy', trader: 'w5', liquiditySol: 32.25, progress: 3.1 },
            { t: 24, txType: 'buy', trader: 'w6', liquiditySol: 32.7, progress: 3.7 },
            { t: 28, txType: 'buy', trader: 'w7', liquiditySol: 33.05, progress: 4.1 },
            { t: 45, txType: 'sell', trader: 'w8', liquiditySol: 31.6, progress: 2.3 },
            { t: 60, txType: 'sell', trader: 'w9', liquiditySol: 30.95, progress: 1.4 }
        ]
    },
    {
        id: 'creatorx',
        description: 'Flow is otherwise clean, but the creator starts unloading during the confirmation window.',
        creator: 'creator-x',
        quality: { holderCount: 26, deployerHoldings: 3.5, top10Concentration: 20 },
        events: [
            { t: 0, txType: 'create', trader: 'creator-x', liquiditySol: 30.3, progress: 0.4, initialBuy: 0.3 },
            { t: 6, txType: 'buy', trader: 'w1', liquiditySol: 30.7, progress: 0.9 },
            { t: 10, txType: 'buy', trader: 'w2', liquiditySol: 31.15, progress: 1.5 },
            { t: 14, txType: 'sell', trader: 'w3', liquiditySol: 30.95, progress: 1.3 },
            { t: 18, txType: 'buy', trader: 'w4', liquiditySol: 31.7, progress: 2.3 },
            { t: 22, txType: 'buy', trader: 'w5', liquiditySol: 32.3, progress: 3.1 },
            { t: 26, txType: 'buy', trader: 'w6', liquiditySol: 32.85, progress: 3.9 },
            { t: 31, txType: 'sell', trader: 'creator-x', liquiditySol: 32.15, progress: 3.0 },
            { t: 44, txType: 'sell', trader: 'w7', liquiditySol: 31.4, progress: 2.0 },
            { t: 58, txType: 'sell', trader: 'creator-x', liquiditySol: 30.75, progress: 1.0 }
        ]
    },
    {
        id: 'stall',
        description: 'Entry looks valid, but the token never really expands after the first leg.',
        creator: 'creator-stall',
        quality: { holderCount: 24, deployerHoldings: 2.9, top10Concentration: 19 },
        events: [
            { t: 0, txType: 'create', trader: 'creator-stall', liquiditySol: 30.28, progress: 0.3, initialBuy: 0.28 },
            { t: 7, txType: 'buy', trader: 'w1', liquiditySol: 30.7, progress: 0.9 },
            { t: 11, txType: 'buy', trader: 'w2', liquiditySol: 31.05, progress: 1.3 },
            { t: 15, txType: 'sell', trader: 'w3', liquiditySol: 30.9, progress: 1.2 },
            { t: 20, txType: 'buy', trader: 'w4', liquiditySol: 31.45, progress: 1.9 },
            { t: 25, txType: 'buy', trader: 'w5', liquiditySol: 32.0, progress: 2.7 },
            { t: 31, txType: 'buy', trader: 'w6', liquiditySol: 32.35, progress: 3.2 },
            { t: 45, txType: 'sell', trader: 'w7', liquiditySol: 32.1, progress: 2.9 },
            { t: 70, txType: 'buy', trader: 'w8', liquiditySol: 32.45, progress: 3.3 },
            { t: 105, txType: 'sell', trader: 'w9', liquiditySol: 31.95, progress: 2.6 },
            { t: 160, txType: 'sell', trader: 'w10', liquiditySol: 31.55, progress: 2.1 }
        ]
    },
    {
        id: 'probepop',
        description: 'Multi-wallet early flow prints, a small shakeout hits, then the launch extends just enough for probe exits.',
        creator: 'creator-probepop',
        quality: { holderCount: 20, deployerHoldings: 2.7, top10Concentration: 18 },
        events: [
            { t: 0, txType: 'create', trader: 'creator-probepop', liquiditySol: 30.24, progress: 0.3, initialBuy: 0.24 },
            { t: 4, txType: 'buy', trader: 'w1', liquiditySol: 30.58, progress: 0.7 },
            { t: 8, txType: 'buy', trader: 'w2', liquiditySol: 30.95, progress: 1.2 },
            { t: 11, txType: 'buy', trader: 'w3', liquiditySol: 31.28, progress: 1.6 },
            { t: 14, txType: 'sell', trader: 'w4', liquiditySol: 31.08, progress: 1.4 },
            { t: 18, txType: 'buy', trader: 'w5', liquiditySol: 31.85, progress: 2.3 },
            { t: 24, txType: 'buy', trader: 'w6', liquiditySol: 32.65, progress: 3.3 },
            { t: 33, txType: 'sell', trader: 'w7', liquiditySol: 32.38, progress: 3.0 },
            { t: 42, txType: 'buy', trader: 'w8', liquiditySol: 33.82, progress: 4.7 },
            { t: 60, txType: 'sell', trader: 'w9', liquiditySol: 33.05, progress: 3.8 }
        ]
    },
    {
        id: 'probetrap',
        description: 'Early prints look busy, but the tape is concentrated and creator selling starts before any real continuation.',
        creator: 'creator-probetrap',
        quality: { holderCount: 14, deployerHoldings: 4.2, top10Concentration: 27 },
        events: [
            { t: 0, txType: 'create', trader: 'creator-probetrap', liquiditySol: 30.22, progress: 0.2, initialBuy: 0.22 },
            { t: 5, txType: 'buy', trader: 'whale-1', liquiditySol: 30.82, progress: 0.9 },
            { t: 8, txType: 'buy', trader: 'whale-1', liquiditySol: 31.46, progress: 1.7 },
            { t: 11, txType: 'buy', trader: 'whale-2', liquiditySol: 32.02, progress: 2.5 },
            { t: 14, txType: 'sell', trader: 'creator-probetrap', liquiditySol: 31.15, progress: 1.4 },
            { t: 18, txType: 'sell', trader: 'whale-1', liquiditySol: 30.55, progress: 0.7 },
            { t: 25, txType: 'sell', trader: 'whale-2', liquiditySol: 30.08, progress: 0.1 }
        ]
    }
];

function formatSol(value: number): string {
    return `${value >= 0 ? '+' : ''}${value.toFixed(4)} SOL`;
}

function main(): void {
    const resultsByStrategy = new Map<StrategyName, RunResult[]>();
    for (const strategy of STRATEGIES) {
        resultsByStrategy.set(
            strategy.name,
            scenarios.map((scenario) => runScenario(strategy.name, scenario))
        );
    }

    console.log('Paper Replay - Conservative vs Aggressive vs Experimental');
    console.log('');

    for (let index = 0; index < scenarios.length; index++) {
        const scenario = scenarios[index];

        console.log(`${scenario.id}: ${scenario.description}`);
        for (const strategy of STRATEGIES) {
            const result = resultsByStrategy.get(strategy.name)?.[index];
            if (!result) continue;
            const entryText = result.entered && result.entryAgeSeconds !== undefined ? ` entry=${result.entryAgeSeconds}s` : '';
            console.log(`  ${strategy.label} -> entered=${result.entered}${entryText} pnl=${formatSol(result.realizedPnlSol)} close=${result.closeReason}`);
        }
    }

    console.log('');
    console.log('Summary');
    for (const strategy of STRATEGIES) {
        const results = resultsByStrategy.get(strategy.name) || [];
        const totalPnl = results.reduce((sum, result) => sum + result.realizedPnlSol, 0);
        const trades = results.filter((result) => result.entered).length;
        const wins = results.filter((result) => result.entered && result.realizedPnlSol > 0).length;
        console.log(`  ${strategy.label} -> trades=${trades} wins=${wins} pnl=${formatSol(totalPnl)}`);
    }
}

main();
