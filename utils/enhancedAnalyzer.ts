import { Connection, PublicKey } from '@solana/web3.js';
import { getPumpData, getTokenMetadata, getHolderStats, getHolderCount, getTokenBalance } from './solanaManager';
import type { TokenData } from '../types/token';
import { getMarketSnapshot, type MarketSnapshot } from './marketData';
import { calculateBondingCurveProgress } from './pumpMath';
import { getTokenAgeSeconds, getTokenLaunchTimestamp } from './tokenTiming';
import { createEmptyPumpLaunchFlags, detectPumpLaunchFlags, type PumpLaunchFlags } from './pumpLaunchFlags';
import { isCreatorDumpingLaunch, top10DistributionMeaningful } from './entrySignals';

type ContractSecurity = {
    freezeAuthority: boolean;
    mintAuthority: boolean;
    updateAuthority: boolean;
    verified: boolean;
};

const contractSecurityCache = new Map<string, ContractSecurity>();
const socialCheckCache = new Map<string, { value: boolean | null; expiresAt: number }>();

type PumpSnapshot = {
    vTokensInBondingCurve: number;
    vSolInBondingCurve: number;
    tokenTotalSupply: number;
    bondingCurveProgress: number;
    source: 'rpc' | 'feed';
};

type HolderMetrics = {
    holderCount: number;
    deployerHoldings: number;
    top10Concentration: number;
};

export interface AdvancedConfig {
    minBondingCurve?: number;
    maxBondingCurve?: number;
    minLiquidity?: number;
    maxLiquidity?: number;
    minHolderCount?: number;
    maxDeployerHoldings?: number;
    minVolume24h?: number;
    minVolume?: number;
    maxDev?: number;
    maxTop10?: number;
    minVelocity?: number;
    rugCheckStrictness?: 'strict' | 'standard' | 'lenient';
    slippage?: number;
    requireSocials?: boolean;
    avoidSnipers?: boolean;
}

export interface TierScores {
    tier0: number; // Metadata & Technical (100 pts needed)
    tier1: number; // Launch Timing (16 pts needed)
    tier2: number; // Holder Distribution (60 pts needed)
    tier3: number; // Engagement Velocity (35 pts needed)
    tier4: number; // Bonding Curve Momentum (50 pts needed)
    totalScore: number;
}

export interface EnhancedAnalysis {
    score: number; // 0-100 legacy score (mapped from Tier total)
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    passed: boolean; // Did it pass the Tier thresholds?
    reasons: string[];
    warnings: string[];
    strengths: string[];
    bondingCurveProgress: number; // 0-100%
    marketCap: number; // SOL
    tiers: TierScores;
    metrics: {
        holderCount: number;
        deployerHoldings: number; // Percentage
        top10Concentration: number; // Percentage
        observedVolume: number; // SOL observed since discovery
        buyPressure: number; // 0-1 (1 = all observed flow is buys)
        bondingCurveVelocity: number; // % per minute
        liquidityDepth: number; // SOL
        tradeCount: number;
        uniqueTraderCount: number;
        repeatTraderRatio: number;
        averageTradeSizeSol: number;
        priceChangePercent: number;
        maxPriceChangePercent: number;
        minPriceChangePercent: number;
        peakLiquiditySol: number;
        peakPrice: number;
        largestTraderVolumeShare: number;
        topTwoTraderVolumeShare: number;
        creatorVolumeShare: number;
        creatorNetFlowSol: number;
        creatorBuyCount: number;
        creatorSellCount: number;
        launchFlags: PumpLaunchFlags;
        contractSecurity: {
            freezeAuthority: boolean; // true = revoked/null (good)
            mintAuthority: boolean; // true = revoked/null (good)
            updateAuthority: boolean; // true = verified immutable, false = active or unverified
            verified: boolean; // true when RPC confirmed the authority state
        };
    };
}

/**
 * Enhanced Token Analyzer based on "2026 Graduate Data Findings"
 * Implements the 4-Tier Framework for early spotted strategy.
 */
export async function analyzeEnhanced(
    token: TokenData,
    connection: Connection,
    heliusKey?: string,
    // Canonical five-mode vocabulary. Callers from the runner already translate
    // legacy env aliases through resolveMode() in config.ts.
    riskMode: 'god' | 'micro' | 'degen' | 'sniper' | 'custom' = 'god',
    config?: AdvancedConfig
): Promise<EnhancedAnalysis> {
    const reasons: string[] = [];
    const warnings: string[] = [];
    const strengths: string[] = [];

    // Map canonical modes to analyzer strategy intent. 'micro' and 'custom'
    // run through the strict tier-compliance pipeline alongside 'god' but use
    // the looser tier thresholds (micro is balanced, custom is user-driven).
    const isGodMode = riskMode === 'god';
    const isRunnerMode = isGodMode || riskMode === 'micro' || riskMode === 'custom';
    const isSniperMode = riskMode === 'sniper';
    const isDegenMode = riskMode === 'degen';
    // Tier floors used to be 60-75 for runner mode and would hard-reject any
    // fresh launch where the holder feed hadn't yet reported. With the rescan
    // loop in place we no longer need to hard-reject here — soft floors let
    // the pipeline keep evaluating as data arrives, and the final pass
    // criteria block actually-bad setups.
    const tier2Floor = isGodMode ? 40 : 30;
    const tier4Floor = isGodMode ? 32 : 25;

    try {
        const rpcPumpData = await getPumpData(token.mint, connection);
        const pumpData = rpcPumpData
            ? { ...rpcPumpData, source: 'rpc' as const }
            : getFeedPumpData(token);
        if (!pumpData) {
            return createRejectResult('Token not found on bonding curve', reasons, warnings, strengths);
        }
        if (pumpData.source === 'feed') {
            warnings.push('RPC market snapshot unavailable - using launch feed data');
        }

        const age = getTokenAgeSeconds(token);
        const liquidity = pumpData.vSolInBondingCurve;
        const marketSnapshot = getMarketSnapshot(token.mint);
        const observedVolume = marketSnapshot?.observedVolumeSol || 0;
        const buyPressure = marketSnapshot?.buyPressure || 0;
        const tradeCount = marketSnapshot?.tradeCount || 0;
        const uniqueTraderCount = marketSnapshot?.uniqueTraderCount || 0;
        const largestTraderVolumeShare = marketSnapshot?.largestTraderVolumeShare || 0;
        const topTwoTraderVolumeShare = marketSnapshot?.topTwoTraderVolumeShare || 0;
        const creatorVolumeShare = marketSnapshot?.creatorVolumeShare || 0;
        const creatorBuyCount = marketSnapshot?.creatorBuyCount || 0;
        const creatorSellCount = marketSnapshot?.creatorSellCount || 0;
        const repeatTraderRatio = marketSnapshot?.repeatTraderRatio || 0;
        const averageTradeSizeSol = marketSnapshot?.averageTradeSizeSol || 0;
        const creatorNetFlowSol = marketSnapshot?.creatorNetFlowSol || 0;
        const maxPriceChangePercent = marketSnapshot?.maxPriceChangePercent || marketSnapshot?.priceChangePercent || 0;
        const minPriceChangePercent = marketSnapshot?.minPriceChangePercent || marketSnapshot?.priceChangePercent || 0;
        const peakLiquiditySol = marketSnapshot?.peakLiquiditySol || liquidity;
        const peakPrice = marketSnapshot?.peakPrice || 0;
        const probeConcentrationSampleReady =
            tradeCount >= 3 ||
            uniqueTraderCount >= 2;
        const degenConcentrationSampleReady =
            tradeCount >= 4 ||
            uniqueTraderCount >= 3;
        const runnerConcentrationSampleReady =
            tradeCount >= 4 ||
            uniqueTraderCount >= 3;

        // Bonding Curve Progress
        const bondingCurveProgress = pumpData.bondingCurveProgress;

        // Get Metadata & Security
        const metadata = isDegenMode
            ? {
                name: token.name || '',
                symbol: token.symbol || '',
                uri: token.uri || ''
            }
            : await getTokenMetadata(token.mint, heliusKey);
        const contractSecurity = await checkContractSecurity(token.mint, connection);
        const launchFlags = detectPumpLaunchFlags(token, metadata);

        if (isDegenMode) {
            warnings.push('Degen fast path active - using launch-feed identity and light trade-flow estimates');
        }
        warnings.push(...launchFlags.summary);

        // === TIER 0: METADATA & TECHNICAL SETUP ===
        // Must pass 100 points (All checks)
        const tier0PassFloor = isDegenMode || isSniperMode ? 80 : 100;
        const tier0 = calculateTier0(token, metadata, contractSecurity, liquidity, {
            allowUnknownAuthorityState: isDegenMode || isSniperMode
        });
        if (tier0.score < 100) {
            // IMMEDIATE REJECT for Runner Mode
            if (isRunnerMode) {
                reasons.push(tier0.reasons[0] || 'Failed Tier 0 Checks');
                return createRejectResult(`TIER 0 FAIL: ${tier0.reasons[0]}`, reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity);
            } else {
                const tier0Label = tier0.score >= tier0PassFloor ? 'TIER 0 WARN' : 'TIER 0 FAIL';
                warnings.push(`${tier0Label}: ${tier0.reasons.join(', ')}`);
            }
        }
        warnings.push(...tier0.warnings);
        strengths.push(...tier0.strengths);

        // === TIER 1: LAUNCH TIMING ===
        const tier1 = calculateTier1(getTokenLaunchTimestamp(token));
        if (isRunnerMode && tier1.score < 16) {
            // We can be lenient here if other scores are exceptional, but note it
            warnings.push(`TIER 1 WEAK: Bad launch time (${tier1.score} pts)`);
        } else if (tier1.score >= 16) {
            strengths.push(...tier1.strengths);
        }

        // === TIER 2: HOLDER DISTRIBUTION ===
        const holderMetrics = isDegenMode
            ? estimateDegenHolderDistribution(marketSnapshot, bondingCurveProgress)
            : await analyzeHolderDistribution(token, connection, heliusKey, bondingCurveProgress);
        const tier2 = calculateTier2(holderMetrics, age);

        if (isRunnerMode && tier2.score < tier2Floor) {
            // Strict fail for Runner
            if (config?.rugCheckStrictness !== 'lenient') {
                reasons.push(`TIER 2 FAIL: Bad distribution. Score ${tier2.score}/${tier2Floor}`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity);
            } else {
                warnings.push(`TIER 2 WEAK: Score ${tier2.score}/${tier2Floor}`);
            }
        } else if (tier2.score > 0) {
            strengths.push(...tier2.strengths);
        }

        // === TIER 3: ENGAGEMENT VELOCITY ===
        // We do a basic check here, can't fully replicate Twitter API v2 without key
        const hasSocials = isDegenMode ? false : await checkSocials(metadata.uri || token.uri);
        if (config?.requireSocials && hasSocials === null) {
            warnings.push('Social verification unavailable in browser build');
        }
        const tier3 = calculateTier3(hasSocials, metadata, age);

        if (isRunnerMode && tier3.score < 35 && config?.rugCheckStrictness === 'strict') {
            warnings.push(`TIER 3 WEAK: Low social signals (${tier3.score} pts)`);
            // We don't auto-reject here because social scraping is limited without API keys
        } else {
            strengths.push(...tier3.strengths);
        }

        // === TIER 4: CURVE MOMENTUM ===
        const curveVelocity = age > 0 ? (bondingCurveProgress / age) * 60 : 0; // % per minute
        const tier4 = calculateTier4(bondingCurveProgress, curveVelocity, riskMode);

        if (isRunnerMode && tier4.score < tier4Floor) {
            if (config?.rugCheckStrictness !== 'lenient') {
                reasons.push(`TIER 4 FAIL: Bad curve momentum. Score ${tier4.score}/${tier4Floor}`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity);
            }
        }
        strengths.push(...tier4.strengths);

        // Compute how much of the observed peak gain has already been given back.
        // maxPriceChangePercent and priceChangePercent are both measured from launch,
        // so (max - current) in percentage-points / max is the fraction surrendered.
        const currentPriceChangePercent = marketSnapshot?.priceChangePercent ?? 0;
        const pricePointsFromPeak = Math.max(0, maxPriceChangePercent - currentPriceChangePercent);
        const peakGivebackFraction = maxPriceChangePercent > 0
            ? Math.min(1, pricePointsFromPeak / maxPriceChangePercent)
            : 0;

        let effectiveConfig = config;
        if (config && isDegenMode) {
            effectiveConfig = { ...config };
            // Require price to still be near its peak before letting the early-flow
            // bypass relax the curve floor. Previously this bypass fired the moment
            // we saw any follow-through trades, even if the price had already rolled
            // over — which was the textbook late-chase that was losing SOL.
            const hasEarlyFlowConfirmation = !!marketSnapshot &&
                age <= 35 &&
                bondingCurveProgress < 8 &&
                peakGivebackFraction <= 0.3 &&
                marketSnapshot.sellCount >= 1 &&
                marketSnapshot.buyCount >= 4 &&
                marketSnapshot.tradeCount >= 6 &&
                marketSnapshot.uniqueTraderCount >= 4 &&
                marketSnapshot.observedVolumeSol >= 1.4 &&
                marketSnapshot.buyPressure >= 0.65;

            if (hasEarlyFlowConfirmation && (effectiveConfig.minBondingCurve ?? 0) > 0) {
                effectiveConfig.minBondingCurve = 0;
                warnings.push('Degen confirmation: bypassing early curve floor due to strong early follow-through');
            }

            if (pumpData.source === 'feed' && (effectiveConfig.minHolderCount ?? 0) > 5) {
                effectiveConfig.minHolderCount = 5;
                warnings.push('Degen fallback: relaxing holder floor to 5 while RPC holder data is unavailable');
            }
        }

        const filterFailure = applyConfigFilters({
            config: effectiveConfig,
            liquidity,
            bondingCurveProgress,
            holderCount: holderMetrics.holderCount,
            top10Concentration: holderMetrics.top10Concentration,
            deployerHoldings: holderMetrics.deployerHoldings,
            observedVolume,
            curveVelocity,
            hasSocials,
            age
        });
        if (filterFailure) {
            reasons.push(filterFailure);
            return createRejectResult(filterFailure, reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity);
        }

        if (!marketSnapshot && age > 15) {
            warnings.push('Observed trade-flow history not yet available');
        }

        // Late-chase guard: only reject once the move has been truly exhausted.
        // Pump.fun tokens routinely give back 30-40% off the peak as part of a
        // healthy consolidation, so we need the peak to be material (30%+) AND
        // most of it gone (60%+) before calling it a late chase.
        if (!isSniperMode && marketSnapshot && maxPriceChangePercent >= 35 && peakGivebackFraction >= 0.65) {
            const reason = `Post-peak entry rejected: ${Math.round(peakGivebackFraction * 100)}% of the ${maxPriceChangePercent.toFixed(0)}% move already given back`;
            reasons.push(reason);
            return createRejectResult(reason, reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity);
        }

        if (isCreatorDumpingLaunch({
            creatorSellCount,
            creatorNetFlowSol,
            creatorVolumeShare,
            age
        })) {
            reasons.push(`Creator is exiting the launch (${creatorSellCount} sell${creatorSellCount === 1 ? '' : 's'})`);
            return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity);
        }

        if (launchFlags.hardBlock && (isRunnerMode || isGodMode)) {
            reasons.push(`Pump launch mode is intentionally excluded from live trading (${launchFlags.tags.join(', ')})`);
            return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
        }

        if (launchFlags.incentiveMode && isGodMode) {
            reasons.push(`Incentive-heavy Pump launch text detected (${launchFlags.tags.join(', ')})`);
            return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
        }

        if (isRunnerMode || isGodMode) {
            // Looser concentration ceilings — these used to mirror the live
            // guard's bars and double-rejected on borderline tape. The live
            // guard already enforces the safety-relevant version of these,
            // so the analyzer only needs to reject obvious wash trading.
            const maxLargestTraderShare = isGodMode ? 0.45 : 0.5;
            const maxTopTwoTraderShare = isGodMode ? 0.65 : 0.7;
            const maxCreatorVolumeShare = isGodMode ? 0.4 : 0.45;
            const maxRepeatTraderRatio = isGodMode ? 0.6 : 0.7;

            if (runnerConcentrationSampleReady && largestTraderVolumeShare > maxLargestTraderShare) {
                reasons.push(`Early flow too concentrated in one wallet (${(largestTraderVolumeShare * 100).toFixed(0)}%)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
            }

            if (runnerConcentrationSampleReady && topTwoTraderVolumeShare > maxTopTwoTraderShare && uniqueTraderCount < 12) {
                reasons.push(`Early flow is dominated by too few wallets (${(topTwoTraderVolumeShare * 100).toFixed(0)}% from top 2)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
            }

            if (runnerConcentrationSampleReady && creatorVolumeShare > maxCreatorVolumeShare && creatorBuyCount > 0 && age >= 12) {
                reasons.push(`Creator-linked flow is too dominant (${(creatorVolumeShare * 100).toFixed(0)}% of observed volume)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
            }

            if (runnerConcentrationSampleReady && repeatTraderRatio > maxRepeatTraderRatio && tradeCount >= 6) {
                reasons.push(`Too much flow is being recycled by the same wallets (${(repeatTraderRatio * 100).toFixed(0)}% repeat traders)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
            }
        } else if (isDegenMode) {
            if (degenConcentrationSampleReady && largestTraderVolumeShare > 0.55 && tradeCount >= 5) {
                reasons.push(`Aggressive flow is too concentrated in one wallet (${(largestTraderVolumeShare * 100).toFixed(0)}%)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
            }

            if (degenConcentrationSampleReady && topTwoTraderVolumeShare > 0.78 && tradeCount >= 6 && uniqueTraderCount < 8) {
                reasons.push(`Aggressive flow is dominated by too few wallets (${(topTwoTraderVolumeShare * 100).toFixed(0)}% from top 2)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
            }

            if (creatorVolumeShare > 0.5 && creatorBuyCount > 0 && age >= 18) {
                reasons.push(`Creator-linked flow is too dominant for aggressive mode (${(creatorVolumeShare * 100).toFixed(0)}%)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
            }

            if (repeatTraderRatio > 0.78 && tradeCount >= 8) {
                reasons.push(`Aggressive tape is being recycled by too few wallets (${(repeatTraderRatio * 100).toFixed(0)}% repeat traders)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
            }
        } else if (isSniperMode) {
            if (probeConcentrationSampleReady && largestTraderVolumeShare > 0.6 && tradeCount >= 4) {
                reasons.push(`Probe flow is too concentrated in one wallet (${(largestTraderVolumeShare * 100).toFixed(0)}%)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
            }

            if (probeConcentrationSampleReady && topTwoTraderVolumeShare > 0.85 && tradeCount >= 5 && uniqueTraderCount < 6) {
                reasons.push(`Probe flow is dominated by too few wallets (${(topTwoTraderVolumeShare * 100).toFixed(0)}% from top 2)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
            }

            if (creatorVolumeShare > 0.55 && creatorBuyCount > 0 && age >= 18) {
                reasons.push(`Creator-linked flow is too dominant for probe mode (${(creatorVolumeShare * 100).toFixed(0)}%)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
            }

            if (repeatTraderRatio > 0.85 && tradeCount >= 6) {
                reasons.push(`Probe tape is too dependent on repeat wallets (${(repeatTraderRatio * 100).toFixed(0)}% repeat traders)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity, launchFlags);
            }
        } else if (largestTraderVolumeShare > 0.42) {
            warnings.push(`Wallet concentration is elevated (${(largestTraderVolumeShare * 100).toFixed(0)}% from one wallet)`);
        }

        // === FINAL DECISION ===
        const totalScore = tier0.score + tier1.score + tier2.score + tier3.score + tier4.score;
        let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'medium';
        let passed = false;

        // Loosened pass criteria. The analyzer used to do tape-shape filtering
        // that *also* lived in the live entry guard, with both demanding bars
        // that almost no real launch can satisfy in <60s. The analyzer now
        // focuses on safety (tier 0, creator dump, hard blocks) and leaves
        // tape-shape decisions to the live guard. This keeps a single gate of
        // truth and lets the rescan loop re-evaluate as the tape develops.
        const godTop10Meaningful = top10DistributionMeaningful(bondingCurveProgress, holderMetrics.holderCount);
        const godTop10Ok =
            !godTop10Meaningful ||
            (holderMetrics.top10Concentration <= 55 &&
                (holderMetrics.deployerHoldings < 0 || holderMetrics.deployerHoldings <= 15));

        if (isGodMode) {
            passed =
                tier0.score >= 100 &&
                tier2.score >= 45 &&
                tier4.score >= 35 &&
                bondingCurveProgress >= 0.3 &&
                godTop10Ok &&
                !isCreatorDumpingLaunch({
                    creatorSellCount,
                    creatorNetFlowSol,
                    creatorVolumeShare,
                    age
                }) &&
                !launchFlags.hardBlock &&
                !launchFlags.incentiveMode;
            riskLevel = passed ? 'low' : 'high';
        } else if (isRunnerMode) {
            // Micro / custom — slightly more permissive than god, still safety-first.
            passed =
                tier0.score >= 100 &&
                tier2.score >= 40 &&
                tier4.score >= 30 &&
                bondingCurveProgress >= 0.3 &&
                !isCreatorDumpingLaunch({
                    creatorSellCount,
                    creatorNetFlowSol,
                    creatorVolumeShare,
                    age
                }) &&
                !launchFlags.hardBlock;
            riskLevel = passed ? 'low' : 'high';
        } else if (isSniperMode) {
            // Sniper analyzer pass is now safety-only. Tape shape is enforced
            // by the live entry guard (which re-evaluates on the rescan loop
            // as the snapshot fills in). The analyzer returning `passed=true`
            // means "this token is not a known scam" — not "this token is
            // ready to enter."
            //
            // Top-10 is structurally elevated at launch (curve <10% or
            // <25 holders) — the fallback estimator returns hardcoded 52/58/
            // 68% concentrations that no fresh launch can satisfy. Skip the
            // distribution check while we're in that regime; once the curve
            // matures the check re-engages.
            const top10IsMeaningful =
                bondingCurveProgress >= 10 && holderMetrics.holderCount >= 25;
            const healthyDistribution =
                !top10IsMeaningful ||
                (holderMetrics.top10Concentration <= 65 &&
                    (holderMetrics.deployerHoldings < 0 || holderMetrics.deployerHoldings <= 18));

            if (!healthyDistribution) {
                reasons.push(`Probe distribution is too concentrated (${holderMetrics.top10Concentration.toFixed(1)}% top 10)`);
            }

            passed =
                tier0.score >= tier0PassFloor &&
                age < 100 &&
                bondingCurveProgress <= 16 &&
                healthyDistribution &&
                !isCreatorDumpingLaunch({
                    creatorSellCount,
                    creatorNetFlowSol,
                    creatorVolumeShare,
                    age
                }) &&
                !launchFlags.hardBlock;
            riskLevel = passed ? 'high' : 'critical';
        } else if (isDegenMode) {
            // Degen analyzer is also safety-only. Tape shape lives in the
            // live entry guard which has both an early-momentum path and the
            // confirmed-continuation path.
            //
            // Same launch-phase exemption as the sniper path above: while
            // we're pre-launch (curve <10%) or holder count is too low
            // (<25) the fallback estimator's hardcoded 52-68% top10 is
            // mathematically guaranteed to fail this check. Skip until
            // the metric is actually meaningful.
            const top10IsMeaningful =
                bondingCurveProgress >= 10 && holderMetrics.holderCount >= 25;
            const healthyDistribution =
                !top10IsMeaningful ||
                (holderMetrics.top10Concentration <= 55 &&
                    (holderMetrics.deployerHoldings < 0 || holderMetrics.deployerHoldings <= 15));

            if (!healthyDistribution) {
                reasons.push(`Aggressive distribution is too concentrated (${holderMetrics.top10Concentration.toFixed(1)}% top 10)`);
            }

            passed =
                tier0.score >= tier0PassFloor &&
                liquidity >= 29.5 &&
                bondingCurveProgress <= 24 &&
                healthyDistribution &&
                !isCreatorDumpingLaunch({
                    creatorSellCount,
                    creatorNetFlowSol,
                    creatorVolumeShare,
                    age
                }) &&
                !launchFlags.hardBlock;
            riskLevel = passed ? 'high' : 'critical';
        } else {
            // Fallback
            passed = totalScore > 200;
        }

        // normalize score to 0-100 for display compatibility
        const displayScore = Math.min(100, Math.round(totalScore / 5));

        return {
            score: displayScore,
            riskLevel,
            passed,
            reasons,
            warnings,
            strengths,
            bondingCurveProgress,
            marketCap: liquidity,
            tiers: {
                tier0: tier0.score,
                tier1: tier1.score,
                tier2: tier2.score,
                tier3: tier3.score,
                tier4: tier4.score,
                totalScore
            },
            metrics: {
                holderCount: holderMetrics.holderCount,
                deployerHoldings: holderMetrics.deployerHoldings,
                top10Concentration: holderMetrics.top10Concentration,
                observedVolume,
                buyPressure,
                bondingCurveVelocity: curveVelocity,
                liquidityDepth: liquidity,
                tradeCount: marketSnapshot?.tradeCount || 0,
                uniqueTraderCount: marketSnapshot?.uniqueTraderCount || 0,
                repeatTraderRatio,
                averageTradeSizeSol,
                priceChangePercent: marketSnapshot?.priceChangePercent || 0,
                maxPriceChangePercent,
                minPriceChangePercent,
                peakLiquiditySol,
                peakPrice,
                largestTraderVolumeShare,
                topTwoTraderVolumeShare,
                creatorVolumeShare,
                creatorNetFlowSol,
                creatorBuyCount,
                creatorSellCount,
                launchFlags,
                contractSecurity
            }
        };

    } catch (error: any) {
        return createRejectResult(`Analysis Error: ${error.message}`, reasons, warnings, strengths);
    }
}

// ==============================================================================
// TIER CALCULATORS
// ==============================================================================

function calculateTier0(
    token: TokenData,
    metadata: any,
    security: ContractSecurity,
    liquidity: number,
    options?: { allowUnknownAuthorityState?: boolean }
) {
    let score = 0;
    const reasons: string[] = [];
    const warnings: string[] = [];
    const strengths: string[] = [];
    const effectiveName = hasUsableMetadataValue(metadata?.name) ? metadata.name : token.name;
    const effectiveSymbol = hasUsableMetadataValue(metadata?.symbol) ? metadata.symbol : token.symbol;
    const usedFeedFallback = !hasUsableMetadataValue(metadata?.name) || !hasUsableMetadataValue(metadata?.symbol);
    const allowUnknownAuthorityState = !!options?.allowUnknownAuthorityState && !security.verified;

    // 1. Metadata URL Present?
    // Some metadata objects return empty uri, so we check name/symbol validity too
    if (hasUsableMetadataValue(effectiveName) && hasUsableMetadataValue(effectiveSymbol)) {
        score += 20;
        if (usedFeedFallback) {
            warnings.push("Metadata API unavailable - using launch feed identity");
        }
    } else {
        reasons.push("No Metadata / Invalid");
        score -= 1000;
    }

    // 2. Token Standard (Legacy vs Token2022)
    score += 20; // Assume legacy for now

    // 3. Freeze Authority Revoked?
    if (security.verified) {
        if (security.freezeAuthority) {
            score += 20;
            strengths.push("Freeze Authority Revoked");
        } else {
            reasons.push("Freeze Authority Active (Honeypot Risk)");
            score -= 1000;
        }
    } else if (allowUnknownAuthorityState) {
        score += 20;
        warnings.push("Freeze authority could not be verified on RPC - using provisional fast-mode pass");
    } else {
        reasons.push("Freeze Authority Unverified");
        score -= 1000;
    }

    // 4. Mint Authority Revoked?
    if (security.verified) {
        if (security.mintAuthority) {
            score += 20;
            strengths.push("Mint Authority Revoked");
        } else {
            reasons.push("Mint Authority Active");
            score -= 1000;
        }
    } else if (allowUnknownAuthorityState) {
        score += 20;
        warnings.push("Mint authority could not be verified on RPC - using provisional fast-mode pass");
    } else {
        reasons.push("Mint Authority Unverified");
        score -= 1000;
    }

    // 5. Symbol/Name Length
    if (effectiveSymbol && effectiveSymbol.length >= 3 && effectiveSymbol.length <= 6) {
        score += 10;
        strengths.push("Optimal Symbol Length");
    }
    if (effectiveName && effectiveName.length >= 4 && effectiveName.length <= 20) {
        score += 10;
    }

    // 6. Liquidity Min Check (Tier 0 basic filter)
    if (liquidity < 0.5) {
        reasons.push("Liquidity ~0 (Dead)");
        score -= 1000;
    }

    return { score, reasons, warnings, strengths };
}

function calculateTier1(timestamp: number) {
    let score = 0;
    const strengths: string[] = [];
    const date = new Date(timestamp);
    const day = date.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const hour = date.getUTCHours();

    // Fri(5)-Sun(0) 11:00-14:00 UTC
    const isWeekend = day === 5 || day === 6 || day === 0;
    const isGoldenHour = hour >= 11 && hour < 14;

    if (isWeekend && isGoldenHour) {
        score += 25;
        strengths.push("Golden Launch Window (Fri-Sun 11-14 UTC)");
    } else if (isGoldenHour) {
        score += 8; // Good time, wrong day
    } else if (isWeekend) {
        score += 16;
        strengths.push("Weekend Launch Boost");
    } else {
        // Mon-Thu
        if (day === 2) { // Tuesday
            score -= 20; // "Graveyard" per research - penalty reduced from -100 to allow finding gems
            strengths.push("Tuesday Caution: Higher Risk Day");
        } else {
            score -= 5;
        }
    }

    return { score, strengths };
}

function calculateTier2(metrics: HolderMetrics, age: number) {
    let score = 0;
    const strengths: string[] = [];

    // 1. Wallet Diversity
    if (metrics.holderCount >= 20) score += 30;
    else if (metrics.holderCount >= 15) score += 25;
    else if (metrics.holderCount >= 10) score += 15;
    else {
        // Less punishing for very fresh tokens (< 45s) since distribution takes time to print
        if (age < 45) {
            score += 10; // Neutral/Positive start for fresh launches
        } else {
            score -= 30;
        }
    }

    // 2. Creator Involvement (Deployer Holdings)
    if (metrics.deployerHoldings >= 0) {
        if (metrics.deployerHoldings < 5) score += 25; // Clean
        else if (metrics.deployerHoldings < 20) score += 0;
        else score -= 50; // Creator hoarding
    }

    // 3. Concentration
    if (metrics.top10Concentration < 10) score += 20;
    else if (metrics.top10Concentration < 20) score += 10;
    else if (metrics.top10Concentration > 50) {
        // Less punishing for very fresh tokens (< 45s) where top-10 is naturally high
        if (age < 45) {
            score -= 10;
        } else {
            score -= 40;
        }
    }

    if (score >= 40) strengths.push("Strong Holder Distribution");

    return { score, strengths };
}

function calculateTier3(hasSocials: boolean | null, metadata: any, age: number) {
    let score = 0;
    const strengths: string[] = [];

    // Can't fully implement Twitter API checks without key
    // Relying on metadata Socials presence
    if (hasSocials === true) {
        score += 25;
        strengths.push("Verified Socials Detected");
    } else if (metadata.description && metadata.description.length > 50) {
        score += 5; // Good description at least
    }

    // Age factor for engagement
    if (age > 300) score += 20; // Sustained presence

    return { score, strengths };
}

function calculateTier4(progress: number, velocity: number, mode: string = 'god') {
    let score = 0;
    const strengths: string[] = [];
    const isAggressive = mode === 'degen' || mode === 'sniper' || mode === 'high' || mode === 'velocity' || mode === 'scalp';

    // 1. Progression Rate (5-15% ideal)
    if (progress >= 5 && progress <= 15) {
        score += 25;
        strengths.push(`Perfect Bonding Curve Position (${progress.toFixed(1)}%)`);
    } else if (progress > 15 && progress <= 30) {
        score += 15;
    } else if (progress > 0 && progress < 5) {
        // Minor penalty for being TOO early (under 1.5%) even if moving fast
        if (progress < 1.5) score -= 15;
        else score += 10;
    } else if (progress > 60) {
        score -= 60; // Flash pump or dead
    }

    // 2. Acceleration
    if (velocity > 0.5 && velocity < 5) {
        score += 25;
        strengths.push(`Organic Growth Velocity (${velocity.toFixed(1)}%/min)`);
    } else if (velocity >= 0.1 && velocity <= 0.5) {
        score += 15; // Steady
    } else if (velocity > 10) {
        if (isAggressive) {
            // No penalty for high velocity in aggressive modes — it's the signal!
            score += 35;
            strengths.push(`Explosive Growth Velocity (${velocity.toFixed(1)}%/min)`);
        } else {
            score -= 20; // Flash pump risk for conservative modes
        }
    } else if (velocity <= 0) {
        score -= 20; // Decelerating
    }

    return { score, strengths };
}

// ==============================================================================
// HELPERS
// ==============================================================================

function createRejectResult(
    reason: string,
    reasons: string[],
    warnings: string[],
    strengths: string[],
    bondingCurveProgress: number = 0,
    marketCap: number = 0,
    contractSecurity?: ContractSecurity,
    launchFlags: PumpLaunchFlags = createEmptyPumpLaunchFlags()
): EnhancedAnalysis {
    if (reasons[reasons.length - 1] !== reason) {
        reasons.push(reason);
    }
    return {
        score: 0,
        riskLevel: 'critical',
        passed: false,
        reasons,
        warnings,
        strengths,
        bondingCurveProgress,
        marketCap,
        tiers: { tier0: 0, tier1: 0, tier2: 0, tier3: 0, tier4: 0, totalScore: 0 },
        metrics: {
            holderCount: 0, deployerHoldings: -1, top10Concentration: 100,
            observedVolume: 0, buyPressure: 0, bondingCurveVelocity: 0, liquidityDepth: 0, tradeCount: 0, uniqueTraderCount: 0, repeatTraderRatio: 0, averageTradeSizeSol: 0, priceChangePercent: 0,
            maxPriceChangePercent: 0, minPriceChangePercent: 0, peakLiquiditySol: 0, peakPrice: 0,
            largestTraderVolumeShare: 0, topTwoTraderVolumeShare: 0, creatorVolumeShare: 0, creatorNetFlowSol: 0, creatorBuyCount: 0, creatorSellCount: 0,
            launchFlags,
            contractSecurity: contractSecurity || { freezeAuthority: false, mintAuthority: false, updateAuthority: false, verified: false }
        }
    };
}

function hasUsableMetadataValue(value?: string): boolean {
    if (!value) return false;
    return !['Unknown', 'Real Token', 'RPC Blocked', 'Cooling Down', 'Rate Limited', 'Forbidden', '???', 'REAL', 'BLOCK', '...', '429', '403'].includes(value);
}

async function checkContractSecurity(mintAddress: string, connection: Connection): Promise<ContractSecurity> {
    const cached = contractSecurityCache.get(mintAddress);
    if (cached) return cached;

    try {
        const mint = new PublicKey(mintAddress);
        const mintInfo = await connection.getParsedAccountInfo(mint);
        if (!mintInfo.value || !mintInfo.value.data || typeof mintInfo.value.data === 'string') {
            return { freezeAuthority: false, mintAuthority: false, updateAuthority: false, verified: false };
        }
        const parsed = mintInfo.value.data as any;
        const result = {
            freezeAuthority: parsed.parsed?.info?.freezeAuthority === null,
            mintAuthority: parsed.parsed?.info?.mintAuthority === null,
            updateAuthority: false,
            verified: true
        };
        contractSecurityCache.set(mintAddress, result);
        return result;
    } catch {
        return { freezeAuthority: false, mintAuthority: false, updateAuthority: false, verified: false };
    }
}

async function checkSocials(uri: string): Promise<boolean | null> {
    if (!uri) return false;
    const cached = socialCheckCache.get(uri);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.value;
    }

    let parsedUri: URL;
    try {
        parsedUri = new URL(uri);
    } catch {
        socialCheckCache.set(uri, { value: false, expiresAt: Date.now() + 300000 });
        return false;
    }

    if (parsedUri.protocol !== 'https:') {
        socialCheckCache.set(uri, { value: false, expiresAt: Date.now() + 300000 });
        return false;
    }

    // Browser clients on Pages cannot reliably fetch arbitrary metadata origins.
    if (typeof window !== 'undefined' && parsedUri.origin !== window.location.origin) {
        socialCheckCache.set(uri, { value: null, expiresAt: Date.now() + 300000 });
        return null;
    }

    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 1500);
        const res = await fetch(uri, { signal: controller.signal });
        if (!res.ok) {
            socialCheckCache.set(uri, { value: false, expiresAt: Date.now() + 300000 });
            return false;
        }
        const json = await res.json();
        const str = JSON.stringify(json).toLowerCase();
        const hasSocials = str.includes("twitter.com") || str.includes("t.me") || str.includes("discord");
        socialCheckCache.set(uri, { value: hasSocials, expiresAt: Date.now() + 300000 });
        return hasSocials;
    } catch {
        socialCheckCache.set(uri, { value: null, expiresAt: Date.now() + 300000 });
        return null;
    }
}

function getFeedPumpData(token: TokenData): PumpSnapshot | null {
    if (!token.vSolInBondingCurve || !token.vTokensInBondingCurve) {
        return null;
    }

    const bondingCurveProgress = calculateBondingCurveProgress(token.vTokensInBondingCurve);

    return {
        vTokensInBondingCurve: token.vTokensInBondingCurve,
        vSolInBondingCurve: token.vSolInBondingCurve,
        tokenTotalSupply: 0,
        bondingCurveProgress,
        source: 'feed'
    };
}

function estimateDegenHolderDistribution(marketSnapshot: MarketSnapshot | null, curveProgress: number = 0): HolderMetrics {
    const uniqueTraderCount = marketSnapshot?.uniqueTraderCount || 0;
    const tradeCount = marketSnapshot?.tradeCount || 0;
    const observedVolume = marketSnapshot?.observedVolumeSol || 0;

    // Give more credit for holders in very fresh launches to avoid hard-rejections
    const holderCount = Math.max(
        uniqueTraderCount,
        Math.ceil(tradeCount * 0.65),
        Math.floor(curveProgress * 2.0) + 12,
        observedVolume >= 2 ? 15 : 0
    );

    const top10Concentration =
        holderCount >= 25 ? 42 :
            holderCount >= 15 ? 52 :
                holderCount >= 10 ? 58 : 65;

    return {
        holderCount,
        deployerHoldings: -1,
        top10Concentration
    };
}

async function analyzeHolderDistribution(token: TokenData, conn: Connection, key?: string, curveProgress: number = 0): Promise<HolderMetrics> {
    try {
        const realStats = await getHolderStats(token.mint, conn);
        const realCount = curveProgress >= 5 ? await getHolderCount(token.mint, conn) : null;

        let holderCount = realCount || Math.floor(curveProgress * 20); // Fallback

        // Refine with real stats
        if (realStats) {
            if (realStats.top10Concentration < 10) holderCount = Math.max(holderCount, 200);
        }

        let deployerHoldings = -1;
        const creatorWallet = token.creatorPublicKey || (token.txType === 'create' ? token.traderPublicKey : '');
        if (realStats?.totalSupply && creatorWallet && creatorWallet !== 'SIM') {
            const creatorBalance = await getTokenBalance(creatorWallet, token.mint, conn);
            deployerHoldings = Math.max(0, Math.min(100, (creatorBalance / realStats.totalSupply) * 100));
        }

        return {
            holderCount,
            deployerHoldings,
            top10Concentration: realStats ? realStats.top10Concentration : 90
        };
    } catch {
        return { holderCount: 5, deployerHoldings: -1, top10Concentration: 90 };
    }
}

function applyConfigFilters({
    config,
    liquidity,
    bondingCurveProgress,
    holderCount,
    top10Concentration,
    deployerHoldings,
    observedVolume,
    curveVelocity,
    hasSocials,
    age
}: {
    config?: AdvancedConfig;
    liquidity: number;
    bondingCurveProgress: number;
    holderCount: number;
    top10Concentration: number;
    deployerHoldings: number;
    observedVolume: number;
    curveVelocity: number;
    hasSocials: boolean | null;
    age: number;
}): string | null {
    if (!config) return null;

    if (config.minLiquidity !== undefined && liquidity < config.minLiquidity) {
        return `Below configured liquidity floor (${liquidity.toFixed(1)} < ${config.minLiquidity} SOL)`;
    }
    if (config.maxLiquidity !== undefined && liquidity > config.maxLiquidity) {
        return `Above configured liquidity ceiling (${liquidity.toFixed(1)} > ${config.maxLiquidity} SOL)`;
    }
    if (config.minHolderCount !== undefined && holderCount < config.minHolderCount) {
        return `Below configured holder minimum (${holderCount} < ${config.minHolderCount})`;
    }
    // Top-10 concentration on Pump.fun is *structurally* elevated for the
    // first ~minute of life: the dev + 4–8 early buyers necessarily own
    // most of the supply that's been traded so far, and the fallback
    // estimator (used whenever RPC market data is unavailable) returns
    // hardcoded 52–68% by holder-count bucket. Enforcing a 42% ceiling at
    // launch is mathematically impossible to satisfy, which is why every
    // fresh launch was being rejected with "Top 10 concentration too high".
    //
    // We skip the check entirely while the curve is still in launch phase
    // (<10% progress) OR there aren't enough holders for the metric to
    // even be meaningful (<25). After either condition is satisfied the
    // filter re-engages and acts as a real distribution check.
    const top10IsMeaningful = bondingCurveProgress >= 10 && holderCount >= 25;
    if (
        config.maxTop10 !== undefined &&
        top10IsMeaningful &&
        top10Concentration > config.maxTop10
    ) {
        return `Top 10 concentration too high (${top10Concentration.toFixed(1)}% > ${config.maxTop10}%)`;
    }

    const maxDevHoldings = config.maxDeployerHoldings ?? config.maxDev;
    if (maxDevHoldings !== undefined && deployerHoldings >= 0 && deployerHoldings > maxDevHoldings) {
        return `Creator holdings too high (${deployerHoldings.toFixed(1)}% > ${maxDevHoldings}%)`;
    }

    if (config.minBondingCurve !== undefined && bondingCurveProgress < config.minBondingCurve) {
        return `Too early on curve (${bondingCurveProgress.toFixed(1)}% < ${config.minBondingCurve}%)`;
    }
    // Velocity-aware curve cap: a token at 27% curve isn't necessarily
    // "late" if it got there in 2 seconds — that's the definition of an
    // explosive launch, not a late-chase setup. When the curve velocity
    // is very high (>60 %/min, equivalent to a token that grew 30%+ in
    // its first half-minute) AND the token is still fresh (<90s), the
    // velocity itself is the early-stage signal and the absolute curve
    // number is the wrong gate. Production logs showed UFO at 177,000
    // SOL/min and 27% curve being rejected this way despite being
    // textbook ignition.
    const isExplosiveLaunch = curveVelocity >= 60 && age < 90;
    if (
        config.maxBondingCurve !== undefined &&
        !isExplosiveLaunch &&
        bondingCurveProgress > config.maxBondingCurve
    ) {
        return `Too late on curve (${bondingCurveProgress.toFixed(1)}% > ${config.maxBondingCurve}%)`;
    }

    const minObservedVolume = config.minVolume24h ?? config.minVolume;
    if (minObservedVolume !== undefined && age > 10) {
        const effectiveMinVolume = age <= 35
            ? Math.min(minObservedVolume, 0.35)
            : age <= 60
                ? Math.min(minObservedVolume, minObservedVolume * 0.7)
                : minObservedVolume;
        if (observedVolume < effectiveMinVolume) {
            return `Observed volume too low (${observedVolume.toFixed(1)} < ${effectiveMinVolume} SOL)`;
        }
    }
    if (config.minVelocity !== undefined) {
        const effectiveMinVelocity = age < 45 ? config.minVelocity * 0.55 : config.minVelocity;
        if (curveVelocity < effectiveMinVelocity) {
            return `Curve velocity too low (${curveVelocity.toFixed(2)} < ${effectiveMinVelocity})`;
        }
    }
    if (config.requireSocials && hasSocials === false) {
        return 'Required socials missing';
    }

    return null;
}
