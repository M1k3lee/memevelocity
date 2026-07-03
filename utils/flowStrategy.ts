/**
 * Flow-based entry strategy — the single source of truth for "should we buy".
 *
 * Derived from captured live tape (runtime/captures). The measured reality of
 * pump.fun launches in our data: ~85% are creator-exits (rugs), ~12% die
 * quietly, and ~3% are genuine runners. The runners are identifiable early by
 * a specific flow signature that the rugs and sniper-flip pumps do not share:
 *
 *   1. Multiple DISTINCT wallets buying (organic interest, not one whale)
 *   2. Very few sells mixed into the early tape (pump-and-dumps show
 *      near-1:1 buy/sell prints from flipping snipers in the first seconds)
 *   3. Real SOL flowing into the curve (several SOL of growth, not dust)
 *   4. The creator NOT selling (a single creator sell predicts the rug)
 *
 * Everything else (holder-count estimates, socials, multi-tier scoring) proved
 * to be noise in the first 60 seconds and is intentionally not part of this
 * decision.
 */

export interface FlowEntryInput {
    /** Token age in seconds since launch. */
    age: number;
    /** Current virtual SOL in the bonding curve (launches at 30). */
    liquiditySol: number;
    /** Bonding curve progress percent (0-100). */
    bondingCurveProgress: number;
    /** Intended entry size in SOL (for curve-impact check). */
    amountSol: number;
    tradeCount: number;
    buyCount: number;
    sellCount: number;
    uniqueTraderCount: number;
    /** SOL net flow (buys minus sells) observed so far. */
    netFlowSol: number;
    buyPressure: number;
    /** Price drift percent from first observation to now. */
    priceChangePercent: number;
    /** Max price drift percent seen so far. */
    maxPriceChangePercent: number;
    largestTraderVolumeShare: number;
    creatorSellCount: number;
}

export interface FlowEntryOptions {
    minAgeSeconds: number;
    maxAgeSeconds: number;
    /** Minimum distinct wallets seen trading (proxy for distinct buyers). */
    minUniqueTraders: number;
    minBuyCount: number;
    /** Reject when sells exceed this fraction of buys (sniper-flip tape). */
    maxSellToBuyRatio: number;
    /** Minimum real SOL added to the curve since launch. */
    minLiquidityGrowthSol: number;
    minBuyPressure: number;
    maxLargestTraderShare: number;
    /**
     * Do not chase: reject entries once price is already this far above the
     * first observation. (Curve *progress* is deliberately not used here — a
     * large initial dev buy can put a brand-new launch at 35%+ progress, so
     * progress says nothing about lateness. Price extension does.)
     */
    maxEntryPriceChangePercent: number;
    maxEntryImpactPercent: number;
}

export interface FlowEntryDecision {
    status: 'pass' | 'wait' | 'reject';
    reason?: string;
}

export type FlowMode = 'god' | 'micro' | 'degen' | 'sniper' | 'custom';

/**
 * Threshold ladders calibrated by parameter sweep over captured live tape
 * (see scripts in the repo history / session notes). The sweep's headline
 * result: on real launch data, PnL degrades monotonically with trade count —
 * the most selective config was the most profitable. God mode sits on that
 * optimum; the looser modes trade a little expected value for activity.
 */
export function getFlowEntryOptions(mode: FlowMode): FlowEntryOptions {
    switch (mode) {
        case 'god':
            return {
                minAgeSeconds: 4,
                maxAgeSeconds: 60,
                minUniqueTraders: 4,
                minBuyCount: 4,
                maxSellToBuyRatio: 0.4,
                minLiquidityGrowthSol: 5,
                minBuyPressure: 0.5,
                maxLargestTraderShare: 0.8,
                maxEntryPriceChangePercent: 25,
                maxEntryImpactPercent: 2.0
            };
        case 'micro':
        case 'custom':
            return {
                minAgeSeconds: 4,
                maxAgeSeconds: 60,
                minUniqueTraders: 4,
                minBuyCount: 4,
                maxSellToBuyRatio: 0.4,
                minLiquidityGrowthSol: 5,
                minBuyPressure: 0.5,
                maxLargestTraderShare: 0.8,
                maxEntryPriceChangePercent: 40,
                maxEntryImpactPercent: 2.2
            };
        case 'degen':
            return {
                minAgeSeconds: 4,
                maxAgeSeconds: 90,
                minUniqueTraders: 3,
                minBuyCount: 4,
                maxSellToBuyRatio: 0.4,
                minLiquidityGrowthSol: 5,
                minBuyPressure: 0.5,
                maxLargestTraderShare: 0.8,
                maxEntryPriceChangePercent: 40,
                maxEntryImpactPercent: 2.5
            };
        case 'sniper':
            return {
                minAgeSeconds: 3,
                maxAgeSeconds: 45,
                minUniqueTraders: 3,
                minBuyCount: 3,
                maxSellToBuyRatio: 0.45,
                minLiquidityGrowthSol: 3,
                minBuyPressure: 0.5,
                maxLargestTraderShare: 0.85,
                maxEntryPriceChangePercent: 40,
                maxEntryImpactPercent: 2.5
            };
    }
}

export function evaluateFlowEntry(input: FlowEntryInput, options: FlowEntryOptions): FlowEntryDecision {
    const {
        age,
        liquiditySol,
        bondingCurveProgress,
        amountSol,
        tradeCount,
        buyCount,
        sellCount,
        uniqueTraderCount,
        netFlowSol,
        buyPressure,
        priceChangePercent,
        maxPriceChangePercent,
        largestTraderVolumeShare,
        creatorSellCount
    } = input;

    // --- Hard rejects (terminal — the launch is disqualified) ---

    // The single strongest rug predictor in our captured data: the creator
    // selling anything. 36/42 captured launches were creator-exits.
    if (creatorSellCount > 0) {
        return {
            status: 'reject',
            reason: `Creator has sold (${creatorSellCount} sell${creatorSellCount === 1 ? '' : 's'}) — rug signature`
        };
    }

    if (age > options.maxAgeSeconds) {
        return {
            status: 'reject',
            reason: `Entry window passed (${age.toFixed(0)}s > ${options.maxAgeSeconds}s)`
        };
    }

    // Sniper-flip tape: pump-and-dumps show near-1:1 buy/sell prints from the
    // first seconds. Genuine runners are mostly accumulation early — but one
    // or two early sells are normal, so demand a real sample (6+ trades)
    // before treating the ratio as signal.
    if (tradeCount >= 6 && sellCount > buyCount * options.maxSellToBuyRatio) {
        return {
            status: 'reject',
            reason: `Sell-heavy tape (${sellCount} sells vs ${buyCount} buys) — flip pattern, not accumulation`
        };
    }

    // One-wallet dominance is structural in the first handful of trades (the
    // first buyer is always most of the volume), so this only means something
    // once the tape has developed.
    if (tradeCount >= 6 && largestTraderVolumeShare > options.maxLargestTraderShare) {
        return {
            status: 'reject',
            reason: `One wallet dominates the tape (${(largestTraderVolumeShare * 100).toFixed(0)}%)`
        };
    }

    if (netFlowSol <= 0 && age >= 15) {
        return {
            status: 'reject',
            reason: `Net flow non-positive at ${age.toFixed(0)}s (${netFlowSol.toFixed(2)} SOL)`
        };
    }

    if (priceChangePercent > options.maxEntryPriceChangePercent) {
        return {
            status: 'reject',
            reason: `Already ${priceChangePercent.toFixed(0)}% above first observation — chasing`
        };
    }

    // Post-peak chase guard: the move happened and is mostly given back.
    if (maxPriceChangePercent >= 25) {
        const giveback = Math.max(0, maxPriceChangePercent - priceChangePercent);
        const givebackFraction = Math.min(1, giveback / maxPriceChangePercent);
        if (givebackFraction >= 0.6) {
            return {
                status: 'reject',
                reason: `Post-peak (peaked ${maxPriceChangePercent.toFixed(0)}%, ${Math.round(givebackFraction * 100)}% given back)`
            };
        }
    }

    if (liquiditySol > 0 && (amountSol / liquiditySol) * 100 > options.maxEntryImpactPercent) {
        return {
            status: 'reject',
            reason: `Entry would move the curve ${((amountSol / liquiditySol) * 100).toFixed(2)}% — too thin`
        };
    }

    // --- Soft gates (wait for the tape to develop, reject once stale) ---

    const liquidityGrowth = liquiditySol - 30;
    const notReadyReason = (() => {
        if (age < options.minAgeSeconds) {
            return `Too young (${age.toFixed(1)}s) — the first seconds are sniper noise`;
        }
        if (uniqueTraderCount < options.minUniqueTraders) {
            return `Only ${uniqueTraderCount} distinct wallet${uniqueTraderCount === 1 ? '' : 's'} (need ${options.minUniqueTraders})`;
        }
        if (buyCount < options.minBuyCount) {
            return `Only ${buyCount} buys (need ${options.minBuyCount})`;
        }
        if (liquidityGrowth < options.minLiquidityGrowthSol) {
            return `Only ${liquidityGrowth.toFixed(2)} SOL of real inflow (need ${options.minLiquidityGrowthSol})`;
        }
        if (buyPressure < options.minBuyPressure) {
            return `Buy pressure ${(buyPressure * 100).toFixed(0)}% below ${(options.minBuyPressure * 100).toFixed(0)}%`;
        }
        if (priceChangePercent <= -3) {
            return `Price is fading right now (${priceChangePercent.toFixed(1)}%)`;
        }
        return null;
    })();

    if (notReadyReason) {
        return age < options.maxAgeSeconds
            ? { status: 'wait', reason: notReadyReason }
            : { status: 'reject', reason: notReadyReason };
    }

    return { status: 'pass' };
}
