import type { EnhancedAnalysis } from '../utils/enhancedAnalyzer';
import { estimatePaperBuyExecution, estimatePaperSellExecution, PAPER_TOKEN_ACCOUNT_RENT_SOL } from '../utils/paperTrading';
import {
    clearAllMarketSnapshots,
    getMarketSnapshot,
    recordMarketEvent
} from '../utils/marketData';
import { calculatePumpPrice } from '../utils/pumpMath';
import { evaluateLiveEntryGuard } from '../utils/liveEntryGuard';
import { createEmptyPumpLaunchFlags } from '../utils/pumpLaunchFlags';
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
import {
    loadReplayScenariosFromSource,
    resolveBundledReplayPackPath,
    resolveCapturePath,
    type ReplayScenario as Scenario,
    type ReplayTapeEvent as ScenarioEvent
} from './captureTools';

const PUMP_INITIAL_VIRTUAL_TOKENS = 1_073_000_000;
const PUMP_CURVE_SALE_TOKENS = 793_100_000;

// Exit presets come straight from bot/config.ts so the replay always runs
// exactly what the live bot runs — no more hand-copied drift.
import { getPresetExitStrategy } from './config';

const LEGACY_EXIT: ManagedExitStrategy = {
    takeProfit: 32,
    takeProfit2: 95,
    stopLoss: 9,
    maxHoldTime: 270,
    trailingStop: false,
    fastKillLoss: 5,
    fastKillSeconds: 14,
    givebackPeakTrigger: 10,
    givebackFloor: 5,
    givebackSeconds: 32,
    stagnationSeconds: 90,
    stagnationFloor: -0.5,
    tp1SellPercent: 40,
    tp2SellPercent: 30,
    postTp1FloorPercent: 8,
    postTp2FloorPercent: 16,
    runnerMaxHoldTime: 960,
    runnerTrailingStopPercent: 20,
    runnerActivationProfit: 30,
    runnerTimeExitFloor: 12
};

const STRICT_EXIT: ManagedExitStrategy = getPresetExitStrategy('god');
const AGGRESSIVE_EXIT: ManagedExitStrategy = getPresetExitStrategy('degen');
const PROBE_EXIT: ManagedExitStrategy = getPresetExitStrategy('sniper');

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

export type StrategyName = 'legacy' | 'strict' | 'aggressive' | 'probe';

export type StrategyConfig = {
    name: StrategyName;
    label: string;
    amountSol: number;
    buySlippagePercent: number;
    exitStrategy: ManagedExitStrategy;
    guardMode?: 'god' | 'degen' | 'sniper';
    useLegacyEntry?: boolean;
};

export type RunResult = {
    strategy: StrategyName;
    entered: boolean;
    entryAgeSeconds?: number;
    realizedPnlSol: number;
    closeReason: string;
};

export const STRATEGIES: StrategyConfig[] = [
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
        amountSol: 0.05,
        buySlippagePercent: 12,
        exitStrategy: STRICT_EXIT,
        guardMode: 'god'
    },
    {
        name: 'aggressive',
        label: 'aggressive',
        amountSol: 0.03,
        buySlippagePercent: 12,
        exitStrategy: AGGRESSIVE_EXIT,
        guardMode: 'degen'
    },
    {
        name: 'probe',
        label: 'probe',
        amountSol: 0.02,
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
            repeatTraderRatio: snapshot?.repeatTraderRatio || 0,
            averageTradeSizeSol: snapshot?.averageTradeSizeSol || 0,
            priceChangePercent: snapshot?.priceChangePercent || 0,
            maxPriceChangePercent: snapshot?.maxPriceChangePercent || 0,
            minPriceChangePercent: snapshot?.minPriceChangePercent || 0,
            peakLiquiditySol: snapshot?.peakLiquiditySol || token.vSolInBondingCurve,
            peakPrice: snapshot?.peakPrice || 0,
            largestTraderVolumeShare: snapshot?.largestTraderVolumeShare || 0,
            topTwoTraderVolumeShare: snapshot?.topTwoTraderVolumeShare || 0,
            creatorVolumeShare: snapshot?.creatorVolumeShare || 0,
            creatorNetFlowSol: snapshot?.creatorNetFlowSol || 0,
            creatorBuyCount: snapshot?.creatorBuyCount || 0,
            creatorSellCount: snapshot?.creatorSellCount || 0,
            launchFlags: createEmptyPumpLaunchFlags(),
            contractSecurity: {
                freezeAuthority: true,
                mintAuthority: true,
                updateAuthority: true,
                verified: true
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
    const maxPriceChangePercent = snapshot?.maxPriceChangePercent || priceChangePercent || 0;
    const impact = liquidity > 0 ? (amountSol / liquidity) * 100 : 100;

    // Late-chase guard — same thresholds as the live entry guard. Only reject
    // when the move was material (30%+ peak) and most of it is already given
    // back (60%+). Pump.fun wicks 30-40% routinely during healthy runs.
    if (maxPriceChangePercent >= 30) {
        const giveback = Math.max(0, maxPriceChangePercent - priceChangePercent);
        const givebackFraction = Math.min(1, giveback / maxPriceChangePercent);
        if (givebackFraction >= 0.6) return false;
    }

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

function executeSell(
    position: Position,
    amountPercent: number,
    price: number,
    curve?: { vSolInBondingCurve?: number; vTokensInBondingCurve?: number } | null
): { realizedDelta: number; closed: boolean } {
    const sellFraction = Math.max(0, Math.min(100, amountPercent)) / 100;
    const soldTokenAmount = position.amountTokens * sellFraction;
    const costBasis = position.buyPrice * soldTokenAmount;
    const sellExecution = estimatePaperSellExecution({
        observedPrice: price,
        amountSolPaid: position.amountSolPaid * sellFraction,
        amountTokens: soldTokenAmount,
        exitStrategy: position.exitStrategy,
        curve,
        failureSeed: `${position.buyTime}:${amountPercent}`
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

function maybeManageExit(
    position: Position,
    price: number,
    now: number,
    curve?: { vSolInBondingCurve?: number; vTokensInBondingCurve?: number } | null
): { closeReason?: string; realizedDelta?: number; closed?: boolean } {
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
            const sell = executeSell(position, 100, price, curve);
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
            const sell = executeSell(position, 100, price, curve);
            return { closeReason: 'giveback-exit', realizedDelta: sell.realizedDelta, closed: sell.closed };
        }
    }

    if (!runnerActive && strategy.stagnationSeconds && strategy.stagnationFloor !== undefined && holdTimeSeconds >= strategy.stagnationSeconds) {
        const peakTrigger = strategy.givebackPeakTrigger ?? 4;
        if (peakPnl < peakTrigger && currentPnl <= strategy.stagnationFloor) {
            const sell = executeSell(position, 100, price, curve);
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
            const sell = executeSell(position, 100, price, curve);
            return { closeReason: 'runner-trailing-stop', realizedDelta: sell.realizedDelta, closed: sell.closed };
        }
    }

    if (currentPnl <= -Math.abs(strategy.stopLoss)) {
        const sell = executeSell(position, 100, price);
        return { closeReason: 'stop-loss', realizedDelta: sell.realizedDelta, closed: sell.closed };
    }

    if (currentPnl >= strategy.takeProfit && !hasTp1Sell(position.partialSells as PartialSellFlags)) {
        const sell = executeSell(position, getTp1SellPercent(strategy), price, curve);
        position.partialSells.tp1 = true;
        return { closeReason: 'tp1', realizedDelta: sell.realizedDelta, closed: sell.closed };
    }

    if (strategy.takeProfit2 && currentPnl >= strategy.takeProfit2 && !hasTp2Sell(position.partialSells as PartialSellFlags)) {
        const sell = executeSell(position, getTp2SellPercent(strategy), price, curve);
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

export function runScenario(strategy: StrategyName, scenario: Scenario): RunResult {
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
                        exitStrategy,
                        curve: {
                            vSolInBondingCurve: token.vSolInBondingCurve,
                            vTokensInBondingCurve: token.vTokensInBondingCurve
                        }
                    });
                    const amountTokens = buyExecution.tokensOut > 0
                        ? buyExecution.tokensOut
                        : ((strategyConfig.amountSol - PAPER_TOKEN_ACCOUNT_RENT_SOL) / buyExecution.fillPrice);

                    position = {
                        buyPrice: buyExecution.fillPrice,
                        amountTokens,
                        amountSolPaid: strategyConfig.amountSol + buyExecution.networkFeeSol + PAPER_TOKEN_ACCOUNT_RENT_SOL,
                        currentPrice: buyExecution.fillPrice,
                        highestPrice: buyExecution.fillPrice,
                        buyTime: now,
                        partialSells: {},
                        exitStrategy,
                        entryAgeSeconds: event.t
                    };
                    entryAgeSeconds = event.t;
                    closeReason = 'open';
                    // Charge the buy-side network/priority fee at entry so the
                    // replay P&L carries the full live cost stack. (Rent nets
                    // out now that full exits close the token account.)
                    realizedPnlSol -= buyExecution.networkFeeSol;
                }
            }

            if (position && price > 0) {
                const currentCurve = {
                    vSolInBondingCurve: token.vSolInBondingCurve,
                    vTokensInBondingCurve: token.vTokensInBondingCurve
                };
                // Creator-sell instant exit (mirrors the live runner). Entry
                // requires zero creator sells, so any count here means the
                // rug started while we were holding.
                const holdingSnapshot = getMarketSnapshot(mint);
                if (holdingSnapshot && holdingSnapshot.creatorSellCount > 0) {
                    const sell = executeSell(position, 100, price, currentCurve);
                    realizedPnlSol += sell.realizedDelta;
                    closeReason = 'creator-sold';
                    position = null;
                    continue;
                }
                const sellResult = maybeManageExit(position, price, now, currentCurve);
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
            const lastCurve = {
                vSolInBondingCurve: lastEvent.liquiditySol,
                vTokensInBondingCurve: vTokensFromProgress(lastEvent.progress)
            };
            const sell = executeSell(position, 100, lastPrice, lastCurve);
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

function formatSol(value: number): string {
    return `${value >= 0 ? '+' : ''}${value.toFixed(4)} SOL`;
}

export type ReplaySourceInfo = {
    scenarios: Scenario[];
    sourcePath: string;
    sourceKind: 'capture' | 'capture-pack';
};

export function resolveReplayScenarios(rawArgs: string[] = process.argv.slice(2)): ReplaySourceInfo {
    const latestCaptureRequested = rawArgs.includes('--latest-capture');
    const captureFlagIndex = rawArgs.indexOf('--capture');
    const captureArgument = captureFlagIndex >= 0 ? rawArgs[captureFlagIndex + 1] : undefined;
    const packFlagIndex = rawArgs.indexOf('--pack');
    const packArgument = packFlagIndex >= 0 ? rawArgs[packFlagIndex + 1] : undefined;

    if (latestCaptureRequested) {
        const capturePath = resolveCapturePath('--latest-capture');
        if (capturePath) {
            const scenarios = loadReplayScenariosFromSource(capturePath);
            if (scenarios.length > 0) {
                return {
                    scenarios,
                    sourcePath: capturePath,
                    sourceKind: 'capture'
                };
            }
        }
    }

    const capturePath = captureArgument ? resolveCapturePath(captureArgument) : null;
    if (capturePath) {
        const scenarios = loadReplayScenariosFromSource(capturePath);
        if (scenarios.length > 0) {
            return {
                scenarios,
                sourcePath: capturePath,
                sourceKind: 'capture'
            };
        }
    }

    const packPath = resolveBundledReplayPackPath(packArgument);
    if (!packPath) {
        throw new Error('No bundled real replay pack found. Add bot/fixtures/realLaunchPack.json or run paper:capture.');
    }

    const scenarios = loadReplayScenariosFromSource(packPath);
    if (scenarios.length === 0) {
        throw new Error(`Bundled replay pack did not contain any scenarios: ${packPath}`);
    }

    return {
        scenarios,
        sourcePath: packPath,
        sourceKind: 'capture-pack'
    };
}

function printOutcomeSummary(scenarios: Scenario[]): void {
    const labels = new Map<string, number>();
    for (const scenario of scenarios) {
        const label = scenario.outcomeLabel || 'unlabeled';
        labels.set(label, (labels.get(label) || 0) + 1);
    }

    if (labels.size === 0) {
        return;
    }

    console.log('Outcome labels');
    for (const [label, count] of [...labels.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${label} -> ${count}`);
    }
    console.log('');
}

export function runReplaySet(scenarios: Scenario[]): Map<StrategyName, RunResult[]> {
    const resultsByStrategy = new Map<StrategyName, RunResult[]>();
    for (const strategy of STRATEGIES) {
        resultsByStrategy.set(
            strategy.name,
            scenarios.map((scenario) => runScenario(strategy.name, scenario))
        );
    }

    return resultsByStrategy;
}

function main(): void {
    const { scenarios, sourcePath, sourceKind } = resolveReplayScenarios();
    const resultsByStrategy = runReplaySet(scenarios);

    console.log(sourceKind === 'capture'
        ? `Paper Replay - Captured Launches (${sourcePath})`
        : `Paper Replay - Bundled Real Launch Pack (${sourcePath})`);
    printOutcomeSummary(scenarios);

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

if (require.main === module) {
    main();
}
