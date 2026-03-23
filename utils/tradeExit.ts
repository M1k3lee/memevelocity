export interface ManagedExitStrategy {
    takeProfit: number;
    takeProfit2?: number;
    stopLoss: number;
    maxHoldTime: number;
    trailingStop: boolean;
    trailingStopPercent?: number;
    momentumExit?: boolean;
    minHoldTime?: number;
    fastKillLoss?: number;
    fastKillSeconds?: number;
    givebackPeakTrigger?: number;
    givebackFloor?: number;
    givebackSeconds?: number;
    stagnationSeconds?: number;
    stagnationFloor?: number;
    tp1SellPercent?: number;
    tp2SellPercent?: number;
    postTp1FloorPercent?: number;
    postTp2FloorPercent?: number;
    runnerMaxHoldTime?: number;
    runnerTrailingStopPercent?: number;
    runnerActivationProfit?: number;
    runnerTimeExitFloor?: number;
}

export type PartialSellFlags = Record<string, boolean> | undefined;

function clampPercent(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value) || value === undefined) {
        return fallback;
    }

    return Math.min(100, Math.max(1, value));
}

export function hasTp1Sell(partialSells: PartialSellFlags): boolean {
    return !!(partialSells?.tp1 || partialSells?.tp2 || partialSells?.["50"] || partialSells?.["80"]);
}

export function hasTp2Sell(partialSells: PartialSellFlags): boolean {
    return !!(partialSells?.tp2 || partialSells?.["80"]);
}

export function getTp1SellPercent(strategy: ManagedExitStrategy | undefined): number {
    return clampPercent(strategy?.tp1SellPercent, 50);
}

export function getTp2SellPercent(strategy: ManagedExitStrategy | undefined): number {
    return clampPercent(strategy?.tp2SellPercent, 30);
}

export function getProfitLockFloor(strategy: ManagedExitStrategy | undefined, partialSells: PartialSellFlags): number | null {
    if (!strategy) {
        return null;
    }

    if (hasTp2Sell(partialSells) && Number.isFinite(strategy.postTp2FloorPercent)) {
        return strategy.postTp2FloorPercent as number;
    }

    if (hasTp1Sell(partialSells) && Number.isFinite(strategy.postTp1FloorPercent)) {
        return strategy.postTp1FloorPercent as number;
    }

    return null;
}

export function getRunnerMaxHoldTime(strategy: ManagedExitStrategy | undefined, partialSells: PartialSellFlags): number | null {
    if (!strategy || !hasTp1Sell(partialSells) || !Number.isFinite(strategy.runnerMaxHoldTime)) {
        return null;
    }

    return strategy.runnerMaxHoldTime as number;
}

export function getRunnerTrailingStopPercent(strategy: ManagedExitStrategy | undefined, partialSells: PartialSellFlags): number | null {
    if (!strategy || !hasTp1Sell(partialSells)) {
        return null;
    }

    const configured = clampPercent(strategy.runnerTrailingStopPercent, 14);
    return hasTp2Sell(partialSells) ? Math.max(6, configured - 2) : configured;
}

export function getRunnerActivationProfit(strategy: ManagedExitStrategy | undefined): number {
    if (!strategy) {
        return 0;
    }

    if (Number.isFinite(strategy.runnerActivationProfit)) {
        return strategy.runnerActivationProfit as number;
    }

    return Math.max(strategy.takeProfit, 10);
}

export function getRunnerTimeExitFloor(strategy: ManagedExitStrategy | undefined): number {
    if (!strategy) {
        return 0;
    }

    if (Number.isFinite(strategy.runnerTimeExitFloor)) {
        return strategy.runnerTimeExitFloor as number;
    }

    if (Number.isFinite(strategy.postTp2FloorPercent)) {
        return strategy.postTp2FloorPercent as number;
    }

    if (Number.isFinite(strategy.postTp1FloorPercent)) {
        return strategy.postTp1FloorPercent as number;
    }

    return 0;
}
