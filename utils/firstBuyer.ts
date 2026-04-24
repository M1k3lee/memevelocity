import { Connection } from '@solana/web3.js';
import type { EnhancedAnalysis } from './enhancedAnalyzer';
import { evaluateLiveEntryGuard } from './liveEntryGuard';
import { getMarketSnapshot } from './marketData';
import { calculateBondingCurveProgress } from './pumpMath';
import { createEmptyPumpLaunchFlags } from './pumpLaunchFlags';
import type { TokenData } from '../types/token';

export interface FirstBuyerSignal {
    status: 'pass' | 'wait' | 'reject';
    shouldBuy: boolean;
    confidence: number;
    reason: string;
    entryTime: number;
    exitStrategy: {
        timeBasedExit: number;
        momentumExit: boolean;
        minHoldTime: number;
        takeProfit: number;
        takeProfit2?: number;
        stopLoss: number;
        positionSize: number;
    };
}

function buildFeedOnlyAnalysis(token: TokenData): EnhancedAnalysis {
    const snapshot = getMarketSnapshot(token.mint);
    const liquidity = token.vSolInBondingCurve || 30;
    const liquidityGrowth = liquidity - 30;
    const bondingCurveProgress = calculateBondingCurveProgress(token.vTokensInBondingCurve);
    const age = token.createdAt ? Math.max(0, (Date.now() - token.createdAt) / 1000) : 0;

    return {
        score: 55,
        riskLevel: 'high',
        passed: false,
        reasons: [],
        warnings: [],
        strengths: [],
        bondingCurveProgress,
        marketCap: liquidity,
        tiers: {
            tier0: 100,
            tier1: 0,
            tier2: 0,
            tier3: 0,
            tier4: 0,
            totalScore: 275
        },
        metrics: {
            holderCount: snapshot?.uniqueTraderCount || 0,
            deployerHoldings: -1,
            top10Concentration: 0,
            observedVolume: snapshot?.observedVolumeSol || Math.max(0, liquidityGrowth),
            buyPressure: snapshot?.buyPressure ?? 0,
            bondingCurveVelocity: age > 0 ? (bondingCurveProgress / age) * 60 : 0,
            liquidityDepth: liquidity,
            tradeCount: snapshot?.tradeCount || 0,
            uniqueTraderCount: snapshot?.uniqueTraderCount || 0,
            repeatTraderRatio: snapshot?.repeatTraderRatio || 0,
            averageTradeSizeSol: snapshot?.averageTradeSizeSol || 0,
            priceChangePercent: snapshot?.priceChangePercent || 0,
            maxPriceChangePercent: snapshot?.maxPriceChangePercent || 0,
            minPriceChangePercent: snapshot?.minPriceChangePercent || 0,
            peakLiquiditySol: snapshot?.peakLiquiditySol || liquidity,
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

function buildDefaultExit(positionSize: number = 0.002): FirstBuyerSignal['exitStrategy'] {
    return {
        timeBasedExit: 30,
        momentumExit: false,
        minHoldTime: 5,
        takeProfit: 8,
        takeProfit2: 14,
        stopLoss: 4,
        positionSize
    };
}

/**
 * Experimental probe mode.
 * This is no longer a literal first-buyer entry. It waits for a tiny amount of
 * real launch flow before allowing a very small, fast probe.
 */
export async function analyzeFirstBuyer(
    token: TokenData,
    _connection: Connection,
    _previousData?: { liquidity: number; timestamp: number }
): Promise<FirstBuyerSignal> {
    const analysis = buildFeedOnlyAnalysis(token);
    const snapshot = getMarketSnapshot(token.mint);
    const observedVolume = snapshot?.observedVolumeSol || 0;
    const tradeCount = snapshot?.tradeCount || 0;
    const uniqueTraderCount = snapshot?.uniqueTraderCount || 0;
    const sellCount = snapshot?.sellCount || 0;
    const buyPressure = snapshot?.buyPressure ?? 0;
    const largestTraderVolumeShare = snapshot?.largestTraderVolumeShare || 0;

    const basePositionSize =
        tradeCount >= 6 && uniqueTraderCount >= 4 && observedVolume >= 1
            ? 0.0025
            : 0.002;

    const guardDecision = evaluateLiveEntryGuard('sniper', token, analysis, basePositionSize);
    if (guardDecision.status === 'reject') {
        return {
            status: 'reject',
            shouldBuy: false,
            confidence: 0,
            reason: guardDecision.reason || 'Probe rejected',
            entryTime: Date.now(),
            exitStrategy: buildDefaultExit(basePositionSize)
        };
    }

    if (guardDecision.status === 'wait') {
        return {
            status: 'wait',
            shouldBuy: false,
            confidence: 35,
            reason: guardDecision.reason || 'Probe not ready yet',
            entryTime: Date.now(),
            exitStrategy: buildDefaultExit(basePositionSize)
        };
    }

    let confidence = 60;
    if (sellCount >= 1) confidence += 8;
    if (tradeCount >= 6) confidence += 6;
    if (uniqueTraderCount >= 4) confidence += 5;
    if (observedVolume >= 1.0) confidence += 4;
    if (buyPressure >= 0.62) confidence += 4;
    if (largestTraderVolumeShare <= 0.32) confidence += 3;
    confidence = Math.max(60, Math.min(86, confidence));

    const exitStrategy = buildDefaultExit(basePositionSize);
    if (sellCount >= 1 && observedVolume >= 1.0) {
        exitStrategy.timeBasedExit = 35;
        exitStrategy.takeProfit = 10;
        exitStrategy.takeProfit2 = 16;
        exitStrategy.stopLoss = 4;
        exitStrategy.positionSize = 0.0025;
    }

    return {
        status: 'pass',
        shouldBuy: true,
        confidence,
        reason: `EARLY PROBE: ${tradeCount} trades, ${uniqueTraderCount} wallets, ${(buyPressure * 100).toFixed(0)}% buy pressure`,
        entryTime: Date.now(),
        exitStrategy
    };
}

export function quickFirstBuyerCheck(token: TokenData): { passed: boolean; reason?: string } {
    const decision = evaluateLiveEntryGuard('sniper', token, buildFeedOnlyAnalysis(token), 0.0025);
    if (decision.status === 'reject') {
        return { passed: false, reason: decision.reason || 'Probe rejected' };
    }

    return { passed: true };
}
