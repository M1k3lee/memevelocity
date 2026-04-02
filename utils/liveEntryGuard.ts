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
    repeatTraderRatio: number;
    buyPressure: number;
    bondingCurveProgress: number;
    netFlow: number;
    priceChangePercent: number;
    stressImpactPercent: number;
    top10Concentration: number;
    creatorHoldings: number;
    largestTraderVolumeShare: number;
    topTwoTraderVolumeShare: number;
    creatorSellCount: number;
}): number {
    const {
        age,
        observedVolume,
        tradeCount,
        uniqueTraderCount,
        repeatTraderRatio,
        buyPressure,
        bondingCurveProgress,
        netFlow,
        priceChangePercent,
        stressImpactPercent,
        top10Concentration,
        creatorHoldings,
        largestTraderVolumeShare,
        topTwoTraderVolumeShare,
        creatorSellCount
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

    if (repeatTraderRatio <= 0.24) score += 8;
    else if (repeatTraderRatio <= 0.36) score += 4;
    else if (repeatTraderRatio > 0.5) score -= 10;

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

    if (largestTraderVolumeShare > 0) {
        if (largestTraderVolumeShare <= 0.22) score += 10;
        else if (largestTraderVolumeShare <= 0.3) score += 4;
        else score -= 14;
    }

    if (topTwoTraderVolumeShare > 0) {
        if (topTwoTraderVolumeShare <= 0.4) score += 8;
        else if (topTwoTraderVolumeShare > 0.52) score -= 10;
    }

    if (creatorSellCount > 0) {
        score -= 35;
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
    const largestTraderVolumeShare = snapshot?.largestTraderVolumeShare || 0;
    const topTwoTraderVolumeShare = snapshot?.topTwoTraderVolumeShare || 0;
    const creatorVolumeShare = snapshot?.creatorVolumeShare || 0;
    const creatorSellCount = snapshot?.creatorSellCount || 0;
    const concentrationSampleReady =
        tradeCount >= 3 ||
        uniqueTraderCount >= 2;

    if (age > 60) {
        return {
            status: 'reject',
            reason: `Probe window already passed (${age.toFixed(0)}s old)`
        };
    }

    if (creatorSellCount > 0 && age <= 180) {
        return {
            status: 'reject',
            reason: `Creator already sold into the launch (${creatorSellCount} sell${creatorSellCount === 1 ? '' : 's'})`
        };
    }

    if (!concentrationSampleReady) {
        return age < 20
            ? {
                status: 'wait',
                reason: `Waiting for a second wallet to join (${tradeCount} trades, ${uniqueTraderCount} wallets, ${observedVolume.toFixed(2)} SOL observed)`
            }
            : {
                status: 'reject',
                reason: `Probe never broadened beyond the opening wallet (${tradeCount} trades, ${uniqueTraderCount} wallets)`
            };
    }

    if (largestTraderVolumeShare > 0.46) {
        return {
            status: 'reject',
            reason: `One wallet still dominates the probe tape (${(largestTraderVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (topTwoTraderVolumeShare > 0.68 && uniqueTraderCount < 8) {
        return {
            status: 'reject',
            reason: `Too much early flow is concentrated in the top 2 wallets (${(topTwoTraderVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (creatorVolumeShare > 0.4 && age >= 12) {
        return {
            status: 'reject',
            reason: `Creator-linked flow is too dominant for a probe (${(creatorVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (sellCount > Math.max(2, Math.floor(tradeCount * 0.5)) && age < 60) {
        return {
            status: 'reject',
            reason: `Early sell pressure is too heavy for a probe (${sellCount}/${tradeCount} sells)`
        };
    }

    if (netFlow < -0.15 && age < 50) {
        return {
            status: 'reject',
            reason: `Net flow turned negative too early (${netFlow.toFixed(2)} SOL)`
        };
    }

    if (tradeCount >= 3 && buyPressure < 0.54) {
        return {
            status: 'reject',
            reason: `Buy pressure is too weak for an early probe (${(buyPressure * 100).toFixed(0)}%)`
        };
    }

    const hasEarlyProbeFlow =
        age <= 10 &&
        buyCount >= 3 &&
        tradeCount >= 3 &&
        uniqueTraderCount >= 3 &&
        observedVolume >= 0.7 &&
        buyPressure >= 0.62 &&
        netFlow >= 0.45;
    const hasShakeoutAbsorb =
        sellCount >= 2 &&
        buyCount >= 3 &&
        tradeCount >= 6 &&
        uniqueTraderCount >= 4 &&
        observedVolume >= 1.0 &&
        buyPressure >= 0.6 &&
        netFlow >= 0.25;
    const hasTapeConfirmation =
        sellCount >= 2 &&
        tradeCount >= 7 &&
        uniqueTraderCount >= 5 &&
        buyPressure >= 0.6 &&
        observedVolume >= 1.2 &&
        netFlow >= 0.35;
    const waitingOnSnapshot =
        age <= 40 &&
        tradeCount === 0 &&
        uniqueTraderCount <= 1 &&
        observedVolume <= 0.35 &&
        liquidityGrowth > 0.2;
    const needsShakeoutConfirmation =
        age >= 15 &&
        observedVolume >= 0.8 &&
        tradeCount >= 4 &&
        sellCount === 0;

    if (needsShakeoutConfirmation) {
        return age < 45
            ? {
                status: 'wait',
                reason: `Waiting for the first probe shakeout (${tradeCount} trades, no sells yet)`
            }
            : {
                status: 'reject',
                reason: `Probe stayed too one-sided and never reset`
            };
    }

    if (hasTapeConfirmation || hasShakeoutAbsorb || hasEarlyProbeFlow) {
        return { status: 'pass' };
    }

    if (age < 10 || waitingOnSnapshot) {
        return {
            status: 'wait',
            reason: `Waiting for first follow-through buy (${tradeCount} trades, ${uniqueTraderCount} wallets, ${observedVolume.toFixed(2)} SOL observed)`
        };
    }

    if (age < 45 && (tradeCount > 0 || liquidityGrowth > 0.4)) {
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

function evaluateMomentumEntry(token: TokenData, analysis: EnhancedAnalysis, amountSol: number): EntryGuardDecision {
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
    const netFlow = snapshot?.netFlowSol || 0;
    const largestTraderVolumeShare = snapshot?.largestTraderVolumeShare || analysis.metrics.largestTraderVolumeShare || 0;
    const topTwoTraderVolumeShare = snapshot?.topTwoTraderVolumeShare || analysis.metrics.topTwoTraderVolumeShare || 0;
    const creatorVolumeShare = snapshot?.creatorVolumeShare || analysis.metrics.creatorVolumeShare || 0;
    const creatorSellCount = snapshot?.creatorSellCount || analysis.metrics.creatorSellCount || 0;
    const repeatTraderRatio = snapshot?.repeatTraderRatio || analysis.metrics.repeatTraderRatio || 0;
    const impact = estimateCurveBuyImpactPercent(liquidity, amountSol);
    const concentrationSampleReady =
        tradeCount >= 4 ||
        uniqueTraderCount >= 3;

    if (age > 60) {
        return {
            status: 'reject',
            reason: `Aggressive continuation window already passed (${age.toFixed(0)}s old)`
        };
    }

    const continuationTape =
        sellCount >= 2 &&
        buyCount >= 4 &&
        tradeCount >= 8 &&
        uniqueTraderCount >= 5 &&
        observedVolume >= 1.5 &&
        buyPressure >= 0.6 &&
        netFlow >= 0.3;
    const strongContinuationTape =
        sellCount >= 2 &&
        tradeCount >= 10 &&
        uniqueTraderCount >= 6 &&
        observedVolume >= 1.8 &&
        buyPressure >= 0.6 &&
        netFlow >= 0.45;
    const curveReady =
        (analysis.bondingCurveProgress >= 2 && analysis.bondingCurveProgress <= 18) ||
        (analysis.bondingCurveProgress >= 1.75 && liquidityGrowth >= 0.8);
    const waitingOnSnapshot =
        age <= 45 &&
        tradeCount === 0 &&
        uniqueTraderCount <= 1 &&
        observedVolume <= 0.2 &&
        liquidityGrowth > 0.25;

    if (creatorSellCount > 0 && age <= 180) {
        return {
            status: 'reject',
            reason: `Creator already sold into the launch (${creatorSellCount} sell${creatorSellCount === 1 ? '' : 's'})`
        };
    }

    if (analysis.metrics.launchFlags.hardBlock) {
        return {
            status: 'reject',
            reason: `Pump launch mode is intentionally excluded (${analysis.metrics.launchFlags.tags.join(', ')})`
        };
    }

    if (!concentrationSampleReady) {
        return age < 24
            ? {
                status: 'wait',
                reason: `Waiting for broader aggressive flow (${tradeCount} trades, ${uniqueTraderCount} wallets, ${observedVolume.toFixed(2)} SOL observed)`
            }
            : {
                status: 'reject',
                reason: `Aggressive flow never broadened beyond the opening wallets (${tradeCount} trades, ${uniqueTraderCount} wallets)`
            };
    }

    if (largestTraderVolumeShare > 0.4) {
        return {
            status: 'reject',
            reason: `One wallet still dominates the aggressive tape (${(largestTraderVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (topTwoTraderVolumeShare > 0.66 && uniqueTraderCount < 10) {
        return {
            status: 'reject',
            reason: `Too much aggressive flow is concentrated in the top 2 wallets (${(topTwoTraderVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (creatorVolumeShare > 0.34 && age >= 12) {
        return {
            status: 'reject',
            reason: `Creator-linked flow is too dominant for aggressive mode (${(creatorVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (repeatTraderRatio > 0.58 && tradeCount >= 6) {
        return {
            status: 'reject',
            reason: `Aggressive tape is too dependent on repeat wallets (${(repeatTraderRatio * 100).toFixed(0)}%)`
        };
    }

    if (waitingOnSnapshot && (analysis.marketCap >= 32 || liquidityGrowth >= 0.8)) {
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

    if (tradeCount >= 4 && buyPressure < 0.56) {
        return {
            status: 'reject',
            reason: `Momentum faded before entry (${(buyPressure * 100).toFixed(0)}% buy pressure)`
        };
    }

    if (impact > 1.8) {
        return {
            status: 'reject',
            reason: `Entry would hit the curve too hard (${impact.toFixed(2)}% impact)`
        };
    }

    if (liquidity < 32) {
        return age < 55
            ? {
                status: 'wait',
                reason: `Aggressive mode still needs a deeper liquidity base (${liquidity.toFixed(2)} SOL)`
            }
            : {
                status: 'reject',
                reason: `Aggressive liquidity never built enough depth (${liquidity.toFixed(2)} SOL)`
            };
    }

    const needsShakeoutConfirmation =
        age >= 18 &&
        observedVolume >= 1.2 &&
        tradeCount >= 6 &&
        sellCount < 2;
    if (needsShakeoutConfirmation) {
        return age < 70
            ? {
                status: 'wait',
                reason: `Waiting for a second aggressive reset (${sellCount} sells, ${tradeCount} trades)`
            }
            : {
                status: 'reject',
                reason: `Aggressive setup never printed a clean second reset`
            };
    }

    if (age >= 20 && buyPressure > 0.9 && sellCount < 1 && uniqueTraderCount < 7) {
        return age < 55
            ? {
                status: 'wait',
                reason: `Tape is still too one-sided for an aggressive continuation (${(buyPressure * 100).toFixed(0)}% buy pressure)`
            }
            : {
                status: 'reject',
                reason: `Aggressive launch stayed too coordinated and never reset`
            };
    }

    if (netFlow <= 0 && age >= 25) {
        return {
            status: 'reject',
            reason: `Net flow is no longer positive (${netFlow.toFixed(2)} SOL)`
        };
    }

    if (!curveReady) {
        return age < 75
            ? {
                status: 'wait',
                reason: `Curve still needs to expand cleanly (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, curve ${analysis.bondingCurveProgress.toFixed(1)}%)`
            }
            : {
                status: 'reject',
                reason: `Aggressive curve never reached a clean continuation window (${analysis.bondingCurveProgress.toFixed(1)}%)`
            };
    }

    if (!(continuationTape || strongContinuationTape)) {
        return age < 75
            ? {
                status: 'wait',
                reason: `Needs stronger continuation tape (${tradeCount} trades, ${sellCount} sells, ${(buyPressure * 100).toFixed(0)}% buy pressure)`
            }
            : {
                status: 'reject',
                reason: `Aggressive tape never confirmed clean continuation (${tradeCount} trades, ${sellCount} sells)`
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
    const bondingCurveProgress = analysis.bondingCurveProgress;
    const largestTraderVolumeShare = snapshot?.largestTraderVolumeShare || analysis.metrics.largestTraderVolumeShare || 0;
    const topTwoTraderVolumeShare = snapshot?.topTwoTraderVolumeShare || analysis.metrics.topTwoTraderVolumeShare || 0;
    const creatorVolumeShare = snapshot?.creatorVolumeShare || analysis.metrics.creatorVolumeShare || 0;
    const creatorSellCount = snapshot?.creatorSellCount || analysis.metrics.creatorSellCount || 0;
    const repeatTraderRatio = snapshot?.repeatTraderRatio || analysis.metrics.repeatTraderRatio || 0;
    const impact = estimateCurveBuyImpactPercent(liquidity, amountSol);
    const isGodMode = mode === 'god';
    const traderDiversity = calculateTraderDiversity(uniqueTraderCount, tradeCount);
    const concentrationSampleReady =
        tradeCount >= 4 ||
        uniqueTraderCount >= 3;

    if (analysis.metrics.launchFlags.hardBlock) {
        return {
            status: 'reject',
            reason: `Pump launch mode is intentionally excluded (${analysis.metrics.launchFlags.tags.join(', ')})`
        };
    }

    if (isGodMode && analysis.metrics.launchFlags.incentiveMode) {
        return {
            status: 'reject',
            reason: `Incentive-heavy Pump launch text detected (${analysis.metrics.launchFlags.tags.join(', ')})`
        };
    }

    if (creatorSellCount > 0 && age <= 180) {
        return {
            status: 'reject',
            reason: `Creator already sold into the launch (${creatorSellCount} sell${creatorSellCount === 1 ? '' : 's'})`
        };
    }

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

    const hardExtendedReject =
        isGodMode &&
        (
            age > 180 ||
            bondingCurveProgress >= 18 ||
            priceChangePercent >= 36 ||
            tradeCount >= 110
        );
    const reclaimWatchTriggered =
        isGodMode &&
        !hardExtendedReject &&
        (
            priceChangePercent >= 14 ||
            bondingCurveProgress >= 11 ||
            tradeCount >= 26
        );
    const reclaimStructureReady =
        reclaimWatchTriggered &&
        age >= 18 &&
        age <= 140 &&
        sellCount >= 1 &&
        tradeCount >= 8 &&
        uniqueTraderCount >= 6 &&
        observedVolume >= 1.25 &&
        buyPressure >= 0.56 &&
        buyPressure <= 0.92 &&
        netFlow >= 0.28 &&
        traderDiversity >= 0.42 &&
        impact <= 1.8;
    const reclaimLaneActive = reclaimWatchTriggered && reclaimStructureReady;

    if (hardExtendedReject) {
        return {
            status: 'reject',
            reason: `Launch is already too extended for conservative mode (price ${priceChangePercent.toFixed(1)}%, curve ${bondingCurveProgress.toFixed(1)}%, trades ${tradeCount}, age ${age.toFixed(0)}s)`
        };
    }

    if (
        isGodMode &&
        age >= 110 &&
        bondingCurveProgress < 6.5 &&
        priceChangePercent < 18 &&
        (observedVolume < 5 || netFlow < 3.6)
    ) {
        return {
            status: 'reject',
            reason: `Runner stayed too stale for conservative mode (price ${priceChangePercent.toFixed(1)}%, curve ${bondingCurveProgress.toFixed(1)}%, age ${age.toFixed(0)}s)`
        };
    }

    if (reclaimWatchTriggered && !reclaimLaneActive) {
        return age < 140
            ? {
                status: 'wait',
                reason: `Extended cleanly, but still waiting for a calmer reclaim (${tradeCount} trades, ${sellCount} sells, curve ${bondingCurveProgress.toFixed(1)}%)`
            }
            : {
                status: 'reject',
                reason: `Extended launch never settled into a conservative reclaim`
            };
    }

    const minimumTrades = isGodMode ? (reclaimLaneActive ? 7 : 8) : 6;
    const minimumWallets = isGodMode ? 6 : 4;
    const minimumVolume = isGodMode ? (reclaimLaneActive ? 1.15 : 1.25) : 1.0;
    const minimumBuyPressure = isGodMode ? (reclaimLaneActive ? 0.58 : 0.6) : 0.57;
    const maximumImpact = isGodMode ? (reclaimLaneActive ? 1.8 : 1.65) : 2.15;
    const maxLargestTraderShare = isGodMode ? (reclaimLaneActive ? 0.38 : 0.3) : 0.35;
    const maxTopTwoTraderShare = isGodMode ? (reclaimLaneActive ? 0.56 : 0.48) : 0.56;
    const maxCreatorVolumeShare = isGodMode ? 0.24 : 0.3;

    if (concentrationSampleReady && largestTraderVolumeShare > maxLargestTraderShare) {
        return {
            status: 'reject',
            reason: `One wallet is driving too much of the tape (${(largestTraderVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (concentrationSampleReady && topTwoTraderVolumeShare > maxTopTwoTraderShare && uniqueTraderCount < 12) {
        return {
            status: 'reject',
            reason: `Too much early flow is coming from the top 2 wallets (${(topTwoTraderVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (concentrationSampleReady && repeatTraderRatio > (isGodMode ? 0.42 : 0.5) && tradeCount >= 6) {
        return {
            status: 'reject',
            reason: `Too much of the tape is being recycled by the same wallets (${(repeatTraderRatio * 100).toFixed(0)}%)`
        };
    }

    if (concentrationSampleReady && creatorVolumeShare > maxCreatorVolumeShare && age >= 15) {
        return {
            status: 'reject',
            reason: `Creator-linked flow is too dominant (${(creatorVolumeShare * 100).toFixed(0)}% of observed volume)`
        };
    }

    const needsShakeoutConfirmation =
        age >= 18 &&
        observedVolume >= minimumVolume &&
        tradeCount >= Math.max(4, minimumTrades - 2) &&
        sellCount < 1;
    if (needsShakeoutConfirmation) {
        return age < 55
            ? {
                status: 'wait',
                reason: `Waiting for the first shakeout and absorb (${tradeCount} trades, no sells yet)`
            }
            : {
                status: 'reject',
                reason: `Runner never showed a clean absorb after the first impulse`
            };
    }

    if (age >= 20 && buyPressure > 0.92 && sellCount === 0 && uniqueTraderCount < minimumWallets + 3) {
        return age < 60
            ? {
                status: 'wait',
                reason: `Order flow is still too one-sided to trust (${(buyPressure * 100).toFixed(0)}% buy pressure, no sells yet)`
            }
            : {
                status: 'reject',
                reason: `Launch stayed too one-sided and looked coordinated`
            };
    }

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
        repeatTraderRatio,
        buyPressure,
        bondingCurveProgress: analysis.bondingCurveProgress,
        netFlow,
        priceChangePercent,
        stressImpactPercent: impact,
        top10Concentration: analysis.metrics.top10Concentration,
        creatorHoldings: analysis.metrics.deployerHoldings,
        largestTraderVolumeShare,
        topTwoTraderVolumeShare,
        creatorSellCount
    });
    const scoreFloor = isGodMode ? (reclaimLaneActive ? 74 : 78) : 70;

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
    if (analysis.metrics.launchFlags.hardBlock) {
        return {
            status: 'reject',
            reason: `Pump launch mode is intentionally excluded (${analysis.metrics.launchFlags.tags.join(', ')})`
        };
    }

    if (mode === 'sniper' || mode === 'first') {
        return evaluateSniperEntry(token);
    }

    if (mode === 'degen' || mode === 'velocity' || mode === 'high' || mode === 'scalp') {
        return evaluateMomentumEntry(token, analysis, amountSol);
    }

    return evaluateRunnerEntry(mode, token, analysis, amountSol);
}
