/**
 * Shared launch-entry signals used by the analyzer, live guard, and UI paths.
 * Keeps creator-dump and dead-tape logic aligned so one layer does not reject
 * what another layer would allow.
 */

export function isCreatorDumpingLaunch(params: {
    creatorSellCount: number;
    creatorNetFlowSol?: number;
    creatorVolumeShare?: number;
    age: number;
}): boolean {
    const {
        creatorSellCount,
        creatorNetFlowSol = 0,
        creatorVolumeShare = 0,
        age
    } = params;

    if (age > 180 || creatorSellCount <= 0) {
        return false;
    }

    // A single creator sell in the opening window is a hard skip to avoid rugs.
    if (creatorSellCount >= 1 && age <= 90) {
        return true;
    }

    // Multiple creator sells is still a hard skip.
    if (creatorSellCount >= 2) {
        return true;
    }

    // One sell is fine if flow is still net-positive and the dev is not exiting.
    if (creatorNetFlowSol < -0.4) {
        return true;
    }

    if (creatorVolumeShare > 0.38 && age <= 90) {
        return true;
    }

    return false;
}

/**
 * Dead tape = price is still weak *now*, or a deep early dip never recovered.
 * Do not use lifetime min dip alone — healthy runners routinely wick -3% to -8%
 * before continuing.
 */
export function isDeadTapeNow(priceDriftPercent: number, minPriceDriftPercent: number): boolean {
    if (priceDriftPercent <= -2.5) {
        return true;
    }

    if (minPriceDriftPercent <= -10 && priceDriftPercent < 5) {
        return true;
    }

    if (minPriceDriftPercent <= -6 && priceDriftPercent <= 1) {
        return true;
    }

    return false;
}

export function top10DistributionMeaningful(bondingCurveProgress: number, holderCount: number): boolean {
    return bondingCurveProgress >= 10 && holderCount >= 25;
}
