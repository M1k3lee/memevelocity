import type { EnhancedAnalysis } from './enhancedAnalyzer';
import { isCreatorDumpingLaunch, isDeadTapeNow } from './entrySignals';
import { getMarketSnapshot } from './marketData';
import type { TokenData } from '../types/token';
import { getTokenAgeSeconds } from './tokenTiming';

// Canonical five-mode vocabulary — callers already resolve legacy aliases
// (runner/safe/medium/high/velocity/scalp/first) to one of these via
// resolveMode() in bot/config.ts.
type GuardMode = 'god' | 'micro' | 'degen' | 'sniper' | 'custom';

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

    // Sniper is the early-entry mode. Its job is to engage in the first 30s
    // of a launch when momentum is forming, not to wait for a perfect
    // shakeout-and-absorb pattern. A single-probe path is added so we can
    // engage on the first 1-2 confirming buys instead of demanding 7+ trades.
    if (age > 90) {
        return {
            status: 'reject',
            reason: `Sniper window already passed (${age.toFixed(0)}s old)`
        };
    }

    const creatorNetFlowSol = snapshot?.creatorNetFlowSol ?? 0;
    if (isCreatorDumpingLaunch({
        creatorSellCount,
        creatorNetFlowSol,
        creatorVolumeShare,
        age
    })) {
        return {
            status: 'reject',
            reason: `Creator is exiting the launch (${creatorSellCount} sell${creatorSellCount === 1 ? '' : 's'}, ${creatorNetFlowSol.toFixed(2)} SOL net)`
        };
    }

    const probePriceDrift = snapshot?.priceChangePercent ?? 0;
    const probeMinDrift = snapshot?.minPriceChangePercent ?? 0;
    if (age >= 12 && tradeCount >= 3 && (isDeadTapeNow(probePriceDrift, probeMinDrift) || probeMinDrift <= -3 || probePriceDrift <= 0)) {
        return age < 75
            ? {
                status: 'wait',
                reason: `Probe tape isn't moving forward cleanly (now ${probePriceDrift.toFixed(1)}%, dipped ${probeMinDrift.toFixed(1)}%)`
            }
            : {
                status: 'reject',
                reason: `Probe tape never built clean displacement (now ${probePriceDrift.toFixed(1)}%, dipped ${probeMinDrift.toFixed(1)}%)`
            };
    }

    // Catch one-wallet dominance patterns very early. The wig-fvyutt creator-exit
    // tape has the first buyer grab ~4.7 SOL out of ~6.5 SOL of observed volume,
    // i.e. the entire probe is one whale before the creator dumps. The previous
    // bar (`> 0.55 && tradeCount >= 4`) waited a tick too long — flowEngage
    // could pass at tradeCount=3 before this check fired. Lowered to fire at
    // tradeCount >= 3 with a 60% bar so genuine breakouts (sword-hkc82o, where
    // the early sniper holds ~56%) still get through.
    if (largestTraderVolumeShare > 0.6 && tradeCount >= 3) {
        return {
            status: 'reject',
            reason: `One wallet still dominates the very early probe tape (${(largestTraderVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (largestTraderVolumeShare > 0.55 && tradeCount >= 4) {
        return {
            status: 'reject',
            reason: `One wallet still dominates the probe tape (${(largestTraderVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (topTwoTraderVolumeShare > 0.78 && tradeCount >= 5 && uniqueTraderCount < 6) {
        return {
            status: 'reject',
            reason: `Too much early flow is concentrated in the top 2 wallets (${(topTwoTraderVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (creatorVolumeShare > 0.5 && age >= 18) {
        return {
            status: 'reject',
            reason: `Creator-linked flow is too dominant for a probe (${(creatorVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (sellCount > Math.max(3, Math.floor(tradeCount * 0.6)) && age < 60) {
        return {
            status: 'reject',
            reason: `Early sell pressure is too heavy for a probe (${sellCount}/${tradeCount} sells)`
        };
    }

    if (netFlow < -0.3 && age < 50) {
        return {
            status: 'reject',
            reason: `Net flow turned negative too early (${netFlow.toFixed(2)} SOL)`
        };
    }

    if (tradeCount >= 4 && buyPressure < 0.5) {
        return {
            status: 'reject',
            reason: `Buy pressure is too weak for an early probe (${(buyPressure * 100).toFixed(0)}%)`
        };
    }

    // Three engagement paths, looser to tighter:
    // 1) earlyEngage: anywhere in the first 35s with any positive follow-through.
    //    The sniper's job is to get in early. If we wait for confluence we miss it.
    // 2) flowEngage: small confirming probe with a couple of wallets joining.
    // 3) confirmedTape: the original "perfect" pattern, kept for completeness.
    const earlyEngage =
        age >= 3 &&
        age <= 40 &&
        buyCount >= 2 &&
        tradeCount >= 2 &&
        uniqueTraderCount >= 2 &&
        buyPressure >= 0.52 &&
        netFlow > 0;
    // flowEngage is the small-confluence path: a couple of wallets joining the
    // probe within the first minute. The age >= 4 floor mirrors earlyEngage —
    // at age <= 3 we cannot reliably distinguish a healthy launch from a tape
    // that is about to absorb a creator dump (see wig-fvyutt where the creator
    // sells at t=3 after a heavy whale buy at t=0).
    const flowEngage =
        age >= 3 &&
        age <= 65 &&
        buyCount >= 2 &&
        tradeCount >= 3 &&
        uniqueTraderCount >= 2 &&
        observedVolume >= 0.3 &&
        buyPressure >= 0.52 &&
        netFlow >= 0.08;
    const confirmedTape =
        age >= 4 &&
        tradeCount >= 6 &&
        uniqueTraderCount >= 4 &&
        buyPressure >= 0.58 &&
        observedVolume >= 1.0 &&
        netFlow >= 0.25;

    if (earlyEngage || flowEngage || confirmedTape) {
        return { status: 'pass' };
    }

    if (age < 60) {
        return {
            status: 'wait',
            reason: `Waiting for early follow-through (${tradeCount} trades, ${uniqueTraderCount} wallets, ${(buyPressure * 100).toFixed(0)}% buy pressure, ${observedVolume.toFixed(2)} SOL observed)`
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

    if (age > 120) {
        return {
            status: 'reject',
            reason: `Aggressive continuation window already passed (${age.toFixed(0)}s old)`
        };
    }

    // Degen's core engagement paths. The original "continuation tape"
    // demanded 8+ trades, 5+ wallets, 1.5 SOL volume AND a sell-and-absorb
    // pattern within 60s — a near-perfect breakout that occurred maybe once
    // an hour. We add a faster early-momentum path so the bot engages on the
    // larger set of healthy launches.
    const earlyMomentum =
        age >= 4 &&
        age <= 55 &&
        tradeCount >= 2 &&
        uniqueTraderCount >= 2 &&
        observedVolume >= 0.3 &&
        buyPressure >= 0.52 &&
        netFlow > 0;
    const continuationTape =
        tradeCount >= 4 &&
        uniqueTraderCount >= 3 &&
        observedVolume >= 0.6 &&
        buyPressure >= 0.52 &&
        netFlow >= 0.1;
    const strongContinuationTape =
        sellCount >= 1 &&
        tradeCount >= 8 &&
        uniqueTraderCount >= 5 &&
        observedVolume >= 1.5 &&
        buyPressure >= 0.58 &&
        netFlow >= 0.35;
    const curveReady =
        (analysis.bondingCurveProgress >= 0.6 && analysis.bondingCurveProgress <= 22) ||
        (analysis.bondingCurveProgress >= 0.3 && liquidityGrowth >= 0.4 && analysis.bondingCurveProgress <= 25);
    const waitingOnSnapshot =
        age <= 45 &&
        tradeCount === 0 &&
        uniqueTraderCount <= 1 &&
        observedVolume <= 0.2 &&
        liquidityGrowth > 0.25;

    const creatorNetFlowSol = snapshot?.creatorNetFlowSol ?? analysis.metrics.creatorNetFlowSol ?? 0;
    if (isCreatorDumpingLaunch({
        creatorSellCount,
        creatorNetFlowSol,
        creatorVolumeShare,
        age
    })) {
        return {
            status: 'reject',
            reason: `Creator is exiting the launch (${creatorSellCount} sell${creatorSellCount === 1 ? '' : 's'}, ${creatorNetFlowSol.toFixed(2)} SOL net)`
        };
    }

    if (analysis.metrics.launchFlags.hardBlock) {
        return {
            status: 'reject',
            reason: `Pump launch mode is intentionally excluded (${analysis.metrics.launchFlags.tags.join(', ')})`
        };
    }

    const priceDriftPercent = snapshot?.priceChangePercent ?? 0;
    const minPriceDriftPercent = snapshot?.minPriceChangePercent ?? 0;
    if (age >= 12 && tradeCount >= 3 && (isDeadTapeNow(priceDriftPercent, minPriceDriftPercent) || minPriceDriftPercent <= -3 || priceDriftPercent <= 0)) {
        return age < 90
            ? {
                status: 'wait',
                reason: `Aggressive tape isn't moving forward cleanly (now ${priceDriftPercent.toFixed(1)}%, dipped ${minPriceDriftPercent.toFixed(1)}%, ${tradeCount} trades)`
            }
            : {
                status: 'reject',
                reason: `Aggressive tape never built clean displacement (now ${priceDriftPercent.toFixed(1)}%, dipped ${minPriceDriftPercent.toFixed(1)}%)`
            };
    }

    if (!concentrationSampleReady) {
        return age < 35
            ? {
                status: 'wait',
                reason: `Waiting for broader aggressive flow (${tradeCount} trades, ${uniqueTraderCount} wallets, ${observedVolume.toFixed(2)} SOL observed)`
            }
            : {
                status: 'reject',
                reason: `Aggressive flow never broadened beyond the opening wallets (${tradeCount} trades, ${uniqueTraderCount} wallets)`
            };
    }

    if (largestTraderVolumeShare > 0.5 && tradeCount >= 5) {
        return {
            status: 'reject',
            reason: `One wallet still dominates the aggressive tape (${(largestTraderVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (topTwoTraderVolumeShare > 0.78 && tradeCount >= 6 && uniqueTraderCount < 8) {
        return {
            status: 'reject',
            reason: `Too much aggressive flow is concentrated in the top 2 wallets (${(topTwoTraderVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (creatorVolumeShare > 0.45 && age >= 18) {
        return {
            status: 'reject',
            reason: `Creator-linked flow is too dominant for aggressive mode (${(creatorVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (repeatTraderRatio > 0.7 && tradeCount >= 8) {
        return {
            status: 'reject',
            reason: `Aggressive tape is too dependent on repeat wallets (${(repeatTraderRatio * 100).toFixed(0)}%)`
        };
    }

    if (waitingOnSnapshot) {
        // Always retry when snapshot hasn't populated yet
        return {
            status: 'wait',
            reason: `Early flow snapshot still syncing (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, curve ${analysis.bondingCurveProgress.toFixed(1)}%)`
        };
    }

    if (sellCount > Math.max(3, Math.floor(tradeCount * 0.55)) && age <= 90) {
        return {
            status: 'reject',
            reason: `Sell pressure is already too heavy (${sellCount}/${tradeCount} sells)`
        };
    }

    if (tradeCount >= 5 && buyPressure < 0.5) {
        return {
            status: 'reject',
            reason: `Momentum faded before entry (${(buyPressure * 100).toFixed(0)}% buy pressure)`
        };
    }

    if (impact > 2.5) {
        return {
            status: 'reject',
            reason: `Entry would hit the curve too hard (${impact.toFixed(2)}% impact)`
        };
    }

    if (liquidity < 30.4) {
        return age < 60
            ? {
                status: 'wait',
                reason: `Aggressive mode still needs a deeper liquidity base (${liquidity.toFixed(2)} SOL)`
            }
            : {
                status: 'reject',
                reason: `Aggressive liquidity never built enough depth (${liquidity.toFixed(2)} SOL)`
            };
    }

    if (netFlow < -0.2 && age >= 30) {
        return {
            status: 'reject',
            reason: `Net flow turned solidly negative (${netFlow.toFixed(2)} SOL)`
        };
    }

    if (!curveReady) {
        return age < 90
            ? {
                status: 'wait',
                reason: `Curve still needs to expand (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, curve ${analysis.bondingCurveProgress.toFixed(1)}%)`
            }
            : {
                status: 'reject',
                reason: `Aggressive curve never reached a clean continuation window (${analysis.bondingCurveProgress.toFixed(1)}%)`
            };
    }

    if (!(earlyMomentum || continuationTape || strongContinuationTape)) {
        return age < 90
            ? {
                status: 'wait',
                reason: `Needs stronger continuation tape (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure)`
            }
            : {
                status: 'reject',
                reason: `Aggressive tape never confirmed clean continuation (${tradeCount} trades)`
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

    const creatorNetFlowSol = snapshot?.creatorNetFlowSol ?? analysis.metrics.creatorNetFlowSol ?? 0;
    if (isCreatorDumpingLaunch({
        creatorSellCount,
        creatorNetFlowSol,
        creatorVolumeShare,
        age
    })) {
        return {
            status: 'reject',
            reason: `Creator is exiting the launch (${creatorSellCount} sell${creatorSellCount === 1 ? '' : 's'}, ${creatorNetFlowSol.toFixed(2)} SOL net)`
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

    // Loosened to match real Pump.fun launch tape. The previous bars (8 trades,
    // 6 wallets, 1.25 SOL volume in <60s) were so high that essentially every
    // launch failed them. We keep god mode meaningfully stricter than micro/
    // custom but still place the bars within reach of healthy-but-not-perfect
    // launches.
    const minimumTrades = isGodMode ? (reclaimLaneActive ? 5 : 4) : 3;       // was 5/5
    const minimumWallets = isGodMode ? 3 : 2;                                  // was 4/3
    const minimumVolume = isGodMode ? (reclaimLaneActive ? 0.6 : 0.6) : 0.35; // was 0.7/0.8/0.45
    const minimumBuyPressure = isGodMode ? (reclaimLaneActive ? 0.52 : 0.52) : 0.5; // was 0.54/0.55
    const maximumImpact = isGodMode ? (reclaimLaneActive ? 2.4 : 2.2) : 2.8;  // was 2.2/2.0/2.6
    const maxLargestTraderShare = isGodMode ? (reclaimLaneActive ? 0.48 : 0.44) : 0.5; // was 0.45/0.4/0.45
    const maxTopTwoTraderShare = isGodMode ? (reclaimLaneActive ? 0.70 : 0.65) : 0.72; // was 0.66/0.6/0.68
    const maxCreatorVolumeShare = isGodMode ? 0.38 : 0.45;                     // was 0.35/0.4

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

    if (concentrationSampleReady && repeatTraderRatio > (isGodMode ? 0.55 : 0.65) && tradeCount >= 8) {
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

    // Shakeout confirmation only applies to god mode now. Micro/custom can
    // engage on continuous up-tape; god still wants the cleaner setup but not
    // strictly enough to reject every clean continuation. Require a well-developed
    // tape (10+ trades, 8+ wallets) before flagging zero-sells as suspicious.
    const needsShakeoutConfirmation =
        isGodMode &&
        age >= 40 &&
        observedVolume >= minimumVolume * 1.8 &&
        tradeCount >= minimumTrades + 5 &&
        uniqueTraderCount >= 8 &&
        sellCount === 0;
    if (needsShakeoutConfirmation) {
        return age < 80
            ? {
                status: 'wait',
                reason: `Waiting for the first shakeout (${tradeCount} trades, no sells yet)`
            }
            : {
                status: 'reject',
                reason: `Runner never showed a clean absorb after the first impulse`
            };
    }

    // One-sided flow: only flag if old enough AND enough traders that zero sells is suspicious
    if (isGodMode && age >= 35 && buyPressure > 0.95 && sellCount === 0 && uniqueTraderCount < minimumWallets + 5) {
        return age < 70
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
        return age < 130
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
    // Score floor: god mode wants quality setups but the floor must be reachable.
    // The composite score starts at 28 and accumulates bonuses — a floor of 74+
    // required near-perfect conditions on every dimension simultaneously.
    const scoreFloor = isGodMode ? (reclaimLaneActive ? 52 : 54) : 48;

    if (score < scoreFloor) {
        return age < 120
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

    // Late-chase guard (applies to every mode except sniper, which is meant to
    // enter before a peak forms). Pump.fun tokens routinely wick 30-40% off a
    // peak as part of healthy consolidation, so the threshold has to be high
    // enough that normal shakeouts don't count as "post-peak chase". Only reject
    // when the move was material (30%+) AND most of it (60%+) is already gone.
    if (mode !== 'sniper') {
        const snapshot = getMarketSnapshot(token.mint);
        if (snapshot) {
            const peak = snapshot.maxPriceChangePercent ?? snapshot.priceChangePercent ?? 0;
            const current = snapshot.priceChangePercent ?? 0;
            const giveback = Math.max(0, peak - current);
            const givebackFraction = peak > 0 ? Math.min(1, giveback / peak) : 0;
            if (peak >= 35 && givebackFraction >= 0.65) {
                return {
                    status: 'reject',
                    reason: `Post-peak entry rejected (peak ${peak.toFixed(0)}%, now ${current.toFixed(0)}%, ${Math.round(givebackFraction * 100)}% of move already given back)`
                };
            }
        }
    }

    if (mode === 'sniper') {
        return evaluateSniperEntry(token);
    }

    if (mode === 'degen') {
        return evaluateMomentumEntry(token, analysis, amountSol);
    }

    // 'god', 'micro', and 'custom' all route through the selective runner gate.
    return evaluateRunnerEntry(mode, token, analysis, amountSol);
}
