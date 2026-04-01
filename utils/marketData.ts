import type { TokenData } from '../types/token';
import { sanitizeTokenIdentity } from './tokenIdentity';
import { calculatePumpPrice } from './pumpMath';
import { getTokenLastSeenTimestamp, getTokenLaunchTimestamp } from './tokenTiming';

export interface MarketSnapshot {
    mint: string;
    symbol: string;
    name: string;
    createdAt: number;
    firstSeenAt: number;
    lastSeenAt: number;
    currentLiquiditySol: number;
    currentPrice: number;
    observedVolumeSol: number;
    buyVolumeSol: number;
    sellVolumeSol: number;
    netFlowSol: number;
    buyPressure: number;
    tradeCount: number;
    buyCount: number;
    sellCount: number;
    uniqueTraderCount: number;
    velocitySolPerMin: number;
    priceChangePercent: number;
    lastTradeType: TokenData['txType'];
    largestTraderVolumeShare: number;
    topTwoTraderVolumeShare: number;
    creatorBuyVolumeSol: number;
    creatorSellVolumeSol: number;
    creatorVolumeShare: number;
    creatorBuyCount: number;
    creatorSellCount: number;
}

interface InternalMarketSnapshot extends MarketSnapshot {
    traderKeys: Set<string>;
    firstObservedPrice: number;
    creatorWallet: string;
    traderVolumes: Map<string, number>;
}

const snapshots = new Map<string, InternalMarketSnapshot>();
const MAX_TRACKED_MINTS = 400;
const SNAPSHOT_TTL_MS = 30 * 60 * 1000;

function cloneSnapshot(snapshot: InternalMarketSnapshot): MarketSnapshot {
    const { traderKeys, firstObservedPrice, creatorWallet, traderVolumes, ...publicSnapshot } = snapshot;
    return publicSnapshot;
}

function normalizeSolValue(value?: number): number {
    if (!value || Number.isNaN(value)) return 0;
    return value > 1_000_000 ? value / 1_000_000_000 : value;
}

function calculatePrice(liquiditySol: number, virtualTokens: number): number {
    if (!liquiditySol || !virtualTokens) return 0;
    return calculatePumpPrice(liquiditySol, virtualTokens);
}

function pruneSnapshots(now: number) {
    for (const [mint, snapshot] of snapshots.entries()) {
        if ((now - snapshot.lastSeenAt) > SNAPSHOT_TTL_MS) {
            snapshots.delete(mint);
        }
    }

    if (snapshots.size <= MAX_TRACKED_MINTS) return;

    const ordered = [...snapshots.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    for (const [mint] of ordered.slice(0, snapshots.size - MAX_TRACKED_MINTS)) {
        snapshots.delete(mint);
    }
}

export function recordMarketEvent(token: TokenData): MarketSnapshot {
    const now = getTokenLastSeenTimestamp(token);
    pruneSnapshots(now);

    const liquiditySol = normalizeSolValue(token.vSolInBondingCurve);
    const currentPrice = calculatePrice(liquiditySol, token.vTokensInBondingCurve);
    const existing = snapshots.get(token.mint);
    const previousLiquidity = existing?.currentLiquiditySol ?? null;
    const creatorWallet = token.creatorPublicKey || existing?.creatorWallet || (token.txType === 'create' ? token.traderPublicKey : '');

    let tradeVolume = 0;
    if (token.txType === 'create') {
        tradeVolume = Math.max(0, normalizeSolValue(token.initialBuy) || Math.max(0, liquiditySol - 30));
    } else if (previousLiquidity !== null) {
        tradeVolume = Math.max(0, Math.abs(liquiditySol - previousLiquidity));
    } else {
        tradeVolume = Math.max(0, Math.abs(liquiditySol - 30));
    }

    const traderKeys = existing?.traderKeys || new Set<string>();
    const traderVolumes = existing?.traderVolumes || new Map<string, number>();
    if (token.traderPublicKey && token.traderPublicKey !== 'SIM') {
        traderKeys.add(token.traderPublicKey);
        traderVolumes.set(
            token.traderPublicKey,
            (traderVolumes.get(token.traderPublicKey) || 0) + tradeVolume
        );
    }

    const creatorMatched = !!creatorWallet && token.traderPublicKey === creatorWallet;
    const nextCreatorBuyVolumeSol =
        (existing?.creatorBuyVolumeSol || 0) +
        ((creatorMatched && token.txType !== 'sell') ? tradeVolume : 0);
    const nextCreatorSellVolumeSol =
        (existing?.creatorSellVolumeSol || 0) +
        ((creatorMatched && token.txType === 'sell') ? tradeVolume : 0);
    const nextCreatorBuyCount =
        (existing?.creatorBuyCount || 0) +
        ((creatorMatched && token.txType !== 'sell') ? 1 : 0);
    const nextCreatorSellCount =
        (existing?.creatorSellCount || 0) +
        ((creatorMatched && token.txType === 'sell') ? 1 : 0);

    const orderedTraderVolumes = [...traderVolumes.values()].sort((a, b) => b - a);
    const totalTraderVolume = orderedTraderVolumes.reduce((sum, value) => sum + value, 0);
    const largestTraderVolumeShare = totalTraderVolume > 0 ? orderedTraderVolumes[0] / totalTraderVolume : 0;
    const topTwoTraderVolumeShare = totalTraderVolume > 0
        ? ((orderedTraderVolumes[0] || 0) + (orderedTraderVolumes[1] || 0)) / totalTraderVolume
        : 0;

    const snapshot: InternalMarketSnapshot = {
        mint: token.mint,
        symbol: sanitizeTokenIdentity(token.symbol) || sanitizeTokenIdentity(existing?.symbol) || '',
        name: sanitizeTokenIdentity(token.name) || sanitizeTokenIdentity(existing?.name) || '',
        createdAt: existing?.createdAt || getTokenLaunchTimestamp(token),
        firstSeenAt: existing?.firstSeenAt || now,
        lastSeenAt: now,
        currentLiquiditySol: liquiditySol,
        currentPrice,
        observedVolumeSol: (existing?.observedVolumeSol || 0) + tradeVolume,
        buyVolumeSol: (existing?.buyVolumeSol || 0) + (token.txType === 'buy' ? tradeVolume : 0),
        sellVolumeSol: (existing?.sellVolumeSol || 0) + (token.txType === 'sell' ? tradeVolume : 0),
        netFlowSol: (existing?.netFlowSol || 0) + (token.txType === 'sell' ? -tradeVolume : tradeVolume),
        buyPressure: 0,
        tradeCount: (existing?.tradeCount || 0) + (token.txType === 'create' ? 0 : 1),
        buyCount: (existing?.buyCount || 0) + (token.txType === 'buy' ? 1 : 0),
        sellCount: (existing?.sellCount || 0) + (token.txType === 'sell' ? 1 : 0),
        uniqueTraderCount: traderKeys.size,
        velocitySolPerMin: 0,
        priceChangePercent: 0,
        lastTradeType: token.txType,
        largestTraderVolumeShare,
        topTwoTraderVolumeShare,
        creatorBuyVolumeSol: nextCreatorBuyVolumeSol,
        creatorSellVolumeSol: nextCreatorSellVolumeSol,
        creatorVolumeShare: 0,
        creatorBuyCount: nextCreatorBuyCount,
        creatorSellCount: nextCreatorSellCount,
        traderKeys,
        firstObservedPrice: existing?.firstObservedPrice || currentPrice,
        creatorWallet,
        traderVolumes
    };

    snapshot.buyPressure = snapshot.observedVolumeSol > 0 ? snapshot.buyVolumeSol / snapshot.observedVolumeSol : 0;
    snapshot.creatorVolumeShare = snapshot.observedVolumeSol > 0
        ? (snapshot.creatorBuyVolumeSol + snapshot.creatorSellVolumeSol) / snapshot.observedVolumeSol
        : 0;

    const observedMinutes = Math.max((snapshot.lastSeenAt - snapshot.firstSeenAt) / 60_000, 0.05);
    snapshot.velocitySolPerMin = snapshot.observedVolumeSol / observedMinutes;

    if (snapshot.firstObservedPrice > 0 && snapshot.currentPrice > 0) {
        snapshot.priceChangePercent = ((snapshot.currentPrice - snapshot.firstObservedPrice) / snapshot.firstObservedPrice) * 100;
    }

    snapshots.set(token.mint, snapshot);
    return cloneSnapshot(snapshot);
}

export function getMarketSnapshot(mint: string): MarketSnapshot | null {
    const snapshot = snapshots.get(mint);
    return snapshot ? cloneSnapshot(snapshot) : null;
}

export function clearMarketSnapshot(mint: string): void {
    snapshots.delete(mint);
}

export function clearAllMarketSnapshots(): void {
    snapshots.clear();
}
