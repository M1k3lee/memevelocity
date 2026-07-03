import type { EnhancedAnalysis } from './enhancedAnalyzer';
import { getMarketSnapshot } from './marketData';
import type { TokenData } from '../types/token';
import { getTokenAgeSeconds } from './tokenTiming';
import { evaluateFlowEntry, getFlowEntryOptions, type FlowMode } from './flowStrategy';

// Canonical five-mode vocabulary — callers already resolve legacy aliases
// (runner/safe/medium/high/velocity/scalp/first) to one of these via
// resolveMode() in bot/config.ts.
type GuardMode = FlowMode;

export interface EntryGuardDecision {
    status: 'pass' | 'wait' | 'reject';
    reason?: string;
    score?: number;
}

/**
 * All modes now route through the flow-based entry strategy; the mode only
 * selects how tight the thresholds are. See utils/flowStrategy.ts for the
 * rationale — the tape-shape decision lives there and nowhere else.
 */
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

    const snapshot = getMarketSnapshot(token.mint);
    const age = getTokenAgeSeconds(token);
    const liquiditySol = token.vSolInBondingCurve || snapshot?.currentLiquiditySol || 30;

    const decision = evaluateFlowEntry(
        {
            age,
            liquiditySol,
            bondingCurveProgress: analysis.bondingCurveProgress,
            amountSol,
            tradeCount: snapshot?.tradeCount ?? analysis.metrics.tradeCount ?? 0,
            buyCount: snapshot?.buyCount ?? 0,
            sellCount: snapshot?.sellCount ?? 0,
            uniqueTraderCount: snapshot?.uniqueTraderCount ?? analysis.metrics.uniqueTraderCount ?? 0,
            netFlowSol: snapshot?.netFlowSol ?? 0,
            buyPressure: snapshot?.buyPressure ?? analysis.metrics.buyPressure ?? 0,
            priceChangePercent: snapshot?.priceChangePercent ?? analysis.metrics.priceChangePercent ?? 0,
            maxPriceChangePercent: snapshot?.maxPriceChangePercent ?? analysis.metrics.maxPriceChangePercent ?? 0,
            largestTraderVolumeShare: snapshot?.largestTraderVolumeShare ?? analysis.metrics.largestTraderVolumeShare ?? 0,
            creatorSellCount: snapshot?.creatorSellCount ?? analysis.metrics.creatorSellCount ?? 0
        },
        getFlowEntryOptions(mode)
    );

    return decision;
}
