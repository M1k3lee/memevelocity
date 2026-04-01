import { Connection } from '@solana/web3.js';
import type { EnhancedAnalysis } from './enhancedAnalyzer';
import { evaluateLiveEntryGuard } from './liveEntryGuard';
import { getMarketSnapshot } from './marketData';
import { calculateBondingCurveProgress } from './pumpMath';
import { createEmptyPumpLaunchFlags } from './pumpLaunchFlags';
import type { TokenData } from '../types/token';

export interface SpeedTradeSignal {
    status: 'pass' | 'wait' | 'reject';
    shouldBuy: boolean;
    confidence: number;
    reason: string;
    momentum: number;
    riskLevel: 'low' | 'medium' | 'high';
    exitStrategy: {
        takeProfit: number;
        stopLoss: number;
        maxHoldTime: number;
        trailingStop: boolean;
    };
}

function buildFeedOnlyAnalysis(token: TokenData): EnhancedAnalysis {
    const snapshot = getMarketSnapshot(token.mint);
    const liquidity = token.vSolInBondingCurve || 30;
    const liquidityGrowth = liquidity - 30;
    const bondingCurveProgress = calculateBondingCurveProgress(token.vTokensInBondingCurve);
    const age = token.createdAt ? Math.max(0, (Date.now() - token.createdAt) / 1000) : 0;

    return {
        score: 62,
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
            totalScore: 310
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
                updateAuthority: true
            }
        }
    };
}

function buildDefaultExit(): SpeedTradeSignal['exitStrategy'] {
    return {
        takeProfit: 8,
        stopLoss: 4,
        maxHoldTime: 40,
        trailingStop: false
    };
}

/**
 * Aggressive continuation mode.
 * This is no longer a blind early momentum chase. It waits for a small shakeout
 * and re-absorption, then trades the next continuation leg with a short leash.
 */
export async function analyzeSpeedTrade(
    token: TokenData,
    _connection: Connection,
    _previousData?: { liquidity: number; timestamp: number }
): Promise<SpeedTradeSignal> {
    const analysis = buildFeedOnlyAnalysis(token);
    const snapshot = getMarketSnapshot(token.mint);
    const liquidity = token.vSolInBondingCurve || 30;
    const liquidityGrowth = liquidity - 30;
    const age = token.createdAt ? Math.max(0, (Date.now() - token.createdAt) / 1000) : 0;
    const momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0;
    const observedVolume = snapshot?.observedVolumeSol || Math.max(0, liquidityGrowth);
    const tradeCount = snapshot?.tradeCount || 0;
    const uniqueTraderCount = snapshot?.uniqueTraderCount || 0;
    const sellCount = snapshot?.sellCount || 0;
    const buyPressure = snapshot?.buyPressure ?? 0;
    const netFlow = snapshot?.netFlowSol || 0;

    const guardDecision = evaluateLiveEntryGuard('scalp', token, analysis, 0.0025);
    if (guardDecision.status === 'reject') {
        return {
            status: 'reject',
            shouldBuy: false,
            confidence: 0,
            reason: guardDecision.reason || 'Aggressive continuation rejected',
            momentum,
            riskLevel: 'high',
            exitStrategy: buildDefaultExit()
        };
    }

    if (guardDecision.status === 'wait') {
        return {
            status: 'wait',
            shouldBuy: false,
            confidence: 40,
            reason: guardDecision.reason || 'Aggressive continuation not ready',
            momentum,
            riskLevel: 'high',
            exitStrategy: buildDefaultExit()
        };
    }

    let confidence = 62;
    if (sellCount >= 1) confidence += 6;
    if (tradeCount >= 8) confidence += 7;
    if (uniqueTraderCount >= 5) confidence += 5;
    if (observedVolume >= 1.5) confidence += 5;
    if (buyPressure >= 0.62) confidence += 4;
    if (netFlow >= 0.5) confidence += 4;
    confidence = Math.max(60, Math.min(88, confidence));

    const exitStrategy = buildDefaultExit();
    if (tradeCount >= 10 && observedVolume >= 1.8) {
        exitStrategy.takeProfit = 10;
        exitStrategy.stopLoss = 4;
        exitStrategy.maxHoldTime = 50;
    } else if (momentum < 0.9) {
        exitStrategy.takeProfit = 6;
        exitStrategy.stopLoss = 4;
        exitStrategy.maxHoldTime = 35;
    }

    const riskLevel: SpeedTradeSignal['riskLevel'] = confidence >= 78 ? 'medium' : 'high';

    return {
        status: 'pass',
        shouldBuy: true,
        confidence,
        reason: `AGGRESSIVE CONTINUATION: ${tradeCount} trades, ${uniqueTraderCount} wallets, ${(buyPressure * 100).toFixed(0)}% buy pressure`,
        momentum,
        riskLevel,
        exitStrategy
    };
}

export function quickSpeedCheck(token: TokenData): { passed: boolean; reason?: string } {
    const decision = evaluateLiveEntryGuard('scalp', token, buildFeedOnlyAnalysis(token), 0.0025);
    if (decision.status === 'reject') {
        return { passed: false, reason: decision.reason || 'Aggressive continuation rejected' };
    }

    return { passed: true };
}
