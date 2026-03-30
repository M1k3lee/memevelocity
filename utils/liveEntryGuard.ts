import type { EnhancedAnalysis } from './enhancedAnalyzer';
import { getMarketSnapshot } from './marketData';
import type { TokenData } from '../types/token';
import { getTokenAgeSeconds } from './tokenTiming';

type GuardMode = 'runner' | 'sniper' | 'degen' | 'god' | 'safe' | 'medium' | 'high' | 'velocity' | 'first' | 'scalp';

export interface EntryGuardDecision {
    status: 'pass' | 'wait' | 'reject';
    reason?: string;
    score?: number;
}

function calculateTraderDiversity(uniqueTraderCount: number, tradeCount: number): number {
    if (!Number.isFinite(uniqueTraderCount) || !Number.isFinite(tradeCount) || uniqueTraderCount <= 0 || tradeCount <= 0) {
        return 0;
    }

    return Math.min(1, uniqueTraderCount / Math.max(1, tradeCount));
}

function estimateCurveBuyImpactPercent(liquiditySol: number, amountSol: number): number {
    if (!Number.isFinite(liquiditySol) || liquiditySol <= 0 || !Number.isFinite(amountSol) || amountSol <= 0) {
        return 100;
    }

    return (amountSol / liquiditySol) * 100;
}

function calculateRunnerSetupScore(params: {
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
    const traderDiversity = calculateTraderDiversity(uniqueTraderCount, tradeCount);
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

function evaluateSniperEntry(token: TokenData): EntryGuardDecision {
    const snapshot = getMarketSnapshot(token.mint);
    const age = getTokenAgeSeconds(token);
    const liquidity = token.vSolInBondingCurve || 30;
    const liquidityGrowth = liquidity - 30;
    const momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0;
    const tradeCount = snapshot?.tradeCount || 0;
    const buyCount = snapshot?.buyCount || 0;
    const sellCount = snapshot?.sellCount || 0;
    const uniqueTraderCount = snapshot?.uniqueTraderCount || 0;
    const buyPressure = snapshot?.buyPressure ?? 0;
    const observedVolume = snapshot?.observedVolumeSol || Math.max(0, liquidityGrowth);
    const netFlow = snapshot?.netFlowSol || 0;

    if (sellCount > buyCount && age < 45) {
        return {
            status: 'reject',
            reason: `Early sell pressure (${sellCount} sells vs ${buyCount} buys)`
        };
    }

    if (netFlow < -0.25 && age < 45) {
        return {
            status: 'reject',
            reason: `Net flow turned negative too early (${netFlow.toFixed(2)} SOL)`
        };
    }

    const hasSecondaryBuyer = uniqueTraderCount >= 2 && (tradeCount >= 1 || buyCount >= 1);
    const hasStrongFlow =
        buyCount >= 2 &&
        tradeCount >= 2 &&
        uniqueTraderCount >= 2 &&
        buyPressure >= 0.6 &&
        observedVolume >= 1.0;
    const hasTapeConfirmation =
        tradeCount >= 6 &&
        uniqueTraderCount >= 3 &&
        buyPressure >= 0.58 &&
        observedVolume >= 1.2;
    const hasCurveConfirmation =
        observedVolume >= 0.6 &&
        (uniqueTraderCount >= 2 || liquidityGrowth >= 1.0);
    const hasFeedOnlyMomentum =
        age <= 35 &&
        tradeCount === 0 &&
        liquidity >= 36 &&
        liquidityGrowth >= 1.0 &&
        momentum >= 1.25;
    const waitingOnSnapshot =
        age <= 40 &&
        tradeCount === 0 &&
        uniqueTraderCount <= 1 &&
        observedVolume <= 0.35 &&
        liquidityGrowth > 0.2;

    if (hasStrongFlow || hasTapeConfirmation || (hasSecondaryBuyer && hasCurveConfirmation) || hasFeedOnlyMomentum) {
        return { status: 'pass' };
    }

    if (age < 12 || waitingOnSnapshot) {
        return {
            status: 'wait',
            reason: `Waiting for first follow-through buy (${tradeCount} trades, ${uniqueTraderCount} wallets, ${observedVolume.toFixed(2)} SOL observed)`
        };
    }

    if (age < 35 && (tradeCount > 0 || liquidityGrowth > 0.4)) {
        return {
            status: 'wait',
            reason: `Need stronger order flow (${buyCount} buys, ${(buyPressure * 100).toFixed(0)}% buy pressure, ${observedVolume.toFixed(2)} SOL observed)`
        };
    }

    return {
        status: 'reject',
        reason: `No follow-through after launch (${tradeCount} trades, ${uniqueTraderCount} wallets, ${observedVolume.toFixed(2)} SOL observed)`
    };
}

function evaluateMomentumEntry(token: TokenData, analysis: EnhancedAnalysis): EntryGuardDecision {
    const snapshot = getMarketSnapshot(token.mint);
    const age = getTokenAgeSeconds(token);
    const liquidity = token.vSolInBondingCurve || 30;
    const liquidityGrowth = liquidity - 30;
    const momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0;
    const tradeCount = snapshot?.tradeCount || analysis.metrics.tradeCount || 0;
    const buyCount = snapshot?.buyCount || 0;
    const sellCount = snapshot?.sellCount || 0;
    const uniqueTraderCount = snapshot?.uniqueTraderCount || analysis.metrics.uniqueTraderCount || 0;
    const observedVolume = snapshot?.observedVolumeSol || analysis.metrics.observedVolume || 0;
    const buyPressure = snapshot?.buyPressure ?? analysis.metrics.buyPressure ?? 0;

    const strongFlowConfirmation =
        buyCount >= 4 &&
        tradeCount >= 6 &&
        uniqueTraderCount >= 4 &&
        observedVolume >= 1.4 &&
        buyPressure >= 0.64;
    const steadyTapeConfirmation =
        tradeCount >= 20 &&
        uniqueTraderCount >= 6 &&
        observedVolume >= 1.8 &&
        buyPressure >= 0.61;
    const feedMomentumConfirmation =
        age <= 45 &&
        tradeCount >= 2 &&
        uniqueTraderCount >= 2 &&
        liquidityGrowth >= 1.0 &&
        momentum >= 1.55 &&
        buyPressure >= 0.55;
    const curveReady =
        (analysis.bondingCurveProgress >= 3 && analysis.bondingCurveProgress <= 16) ||
        (analysis.bondingCurveProgress >= 1.75 && liquidityGrowth >= 0.8);
    const deepLiquidityConfirmation =
        analysis.marketCap >= 55 &&
        observedVolume >= 1.5 &&
        uniqueTraderCount >= 4 &&
        (analysis.bondingCurveProgress >= 2 || liquidityGrowth >= 1.0);
    const waitingOnSnapshot =
        age <= 45 &&
        tradeCount === 0 &&
        uniqueTraderCount <= 1 &&
        observedVolume <= 0.2 &&
        liquidityGrowth > 0.25;

    if (waitingOnSnapshot && (feedMomentumConfirmation || analysis.marketCap >= 35)) {
        return {
            status: 'wait',
            reason: `Early flow snapshot still syncing (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, curve ${analysis.bondingCurveProgress.toFixed(1)}%)`
        };
    }

    if (sellCount > Math.max(2, Math.floor(tradeCount * 0.4)) && age <= 90) {
        return {
            status: 'reject',
            reason: `Sell pressure is already too heavy (${sellCount}/${tradeCount} sells)`
        };
    }

    if (buyPressure < 0.55 && tradeCount >= 4) {
        return {
            status: 'reject',
            reason: `Momentum faded before entry (${(buyPressure * 100).toFixed(0)}% buy pressure)`
        };
    }

    if (!curveReady && !strongFlowConfirmation && !steadyTapeConfirmation && !deepLiquidityConfirmation && !feedMomentumConfirmation) {
        return age < 75
            ? {
                status: 'wait',
                reason: `Needs more early flow (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, curve ${analysis.bondingCurveProgress.toFixed(1)}%)`
            }
            : {
                status: 'reject',
                reason: `Early flow stayed too weak (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, curve ${analysis.bondingCurveProgress.toFixed(1)}%)`
            };
    }

    return { status: 'pass' };
}

function evaluateRunnerEntry(mode: GuardMode, token: TokenData, analysis: EnhancedAnalysis, amountSol: number): EntryGuardDecision {
    const snapshot = getMarketSnapshot(token.mint);
    const age = getTokenAgeSeconds(token);
    const liquidity = token.vSolInBondingCurve || analysis.marketCap || 30;
    const liquidityGrowth = liquidity - 30;
    const tradeCount = snapshot?.tradeCount || analysis.metrics.tradeCount || 0;
    const sellCount = snapshot?.sellCount || 0;
    const uniqueTraderCount = snapshot?.uniqueTraderCount || analysis.metrics.uniqueTraderCount || 0;
    const observedVolume = snapshot?.observedVolumeSol || analysis.metrics.observedVolume || 0;
    const buyPressure = snapshot?.buyPressure ?? analysis.metrics.buyPressure ?? 0;
    const netFlow = snapshot?.netFlowSol || 0;
    const priceChangePercent = snapshot?.priceChangePercent || analysis.metrics.priceChangePercent || 0;
    const impact = estimateCurveBuyImpactPercent(liquidity, amountSol);
    const isGodMode = mode === 'god';

    if (sellCount > Math.max(2, Math.floor(tradeCount * 0.45)) && age <= 90) {
        return {
            status: 'reject',
            reason: `Sell pressure too high (${sellCount}/${tradeCount} sells)`
        };
    }

    if (netFlow <= 0 && age >= 20) {
        return {
            status: 'reject',
            reason: `Net flow is no longer positive (${netFlow.toFixed(2)} SOL)`
        };
    }

    const waitingOnSnapshot =
        age <= 45 &&
        tradeCount === 0 &&
        uniqueTraderCount <= 1 &&
        observedVolume <= 0.25 &&
        liquidityGrowth > 0.25;
    if (waitingOnSnapshot) {
        return {
            status: 'wait',
            reason: `Waiting for tape to print (${tradeCount} trades, ${uniqueTraderCount} wallets, ${observedVolume.toFixed(2)} SOL observed)`
        };
    }

    const minimumTrades = isGodMode ? 8 : 6;
    const minimumWallets = isGodMode ? 6 : 4;
    const minimumVolume = isGodMode ? 1.25 : 1.0;
    const minimumBuyPressure = isGodMode ? 0.6 : 0.57;
    const maximumImpact = isGodMode ? 1.8 : 2.4;

    if (impact > maximumImpact) {
        return {
            status: 'reject',
            reason: `Entry would hit the curve too hard (${impact.toFixed(2)}% impact)`
        };
    }

    if (
        tradeCount < minimumTrades ||
        uniqueTraderCount < minimumWallets ||
        observedVolume < minimumVolume ||
        buyPressure < minimumBuyPressure
    ) {
        return age < 110
            ? {
                status: 'wait',
                reason: `Runner tape not ready (${tradeCount} trades, ${uniqueTraderCount} wallets, ${(buyPressure * 100).toFixed(0)}% buy pressure, ${observedVolume.toFixed(2)} SOL observed)`
            }
            : {
                status: 'reject',
                reason: `Runner confirmation never arrived (${tradeCount} trades, ${uniqueTraderCount} wallets, ${(buyPressure * 100).toFixed(0)}% buy pressure)`
            };
    }

    const score = calculateRunnerSetupScore({
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
    const scoreFloor = isGodMode ? 74 : 68;

    if (score < scoreFloor) {
        return age < 95
            ? {
                status: 'wait',
                reason: `Composite runner score is still weak (${score}/100)`
            }
            : {
                status: 'reject',
                reason: `Composite runner score stayed below floor (${score}/100)`
            };
    }

    return {
        status: 'pass',
        score
    };
}

export function evaluateLiveEntryGuard(
    mode: GuardMode,
    token: TokenData,
    analysis: EnhancedAnalysis,
    amountSol: number
): EntryGuardDecision {
    if (mode === 'sniper' || mode === 'first' || mode === 'scalp') {
        return evaluateSniperEntry(token);
    }

    if (mode === 'degen' || mode === 'velocity' || mode === 'high') {
        return evaluateMomentumEntry(token, analysis);
    }

    return evaluateRunnerEntry(mode, token, analysis, amountSol);
}
