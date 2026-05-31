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
    repeatTraderRatio: number;
    averageTradeSizeSol: number;
    velocitySolPerMin: number;
    priceChangePercent: number;
    maxPriceChangePercent: number;
    minPriceChangePercent: number;
    peakLiquiditySol: number;
    peakPrice: number;
    lastTradeType: TokenData['txType'];
    largestTraderVolumeShare: number;
    topTwoTraderVolumeShare: number;
    creatorBuyVolumeSol: number;
    creatorSellVolumeSol: number;
    creatorNetFlowSol: number;
    creatorVolumeShare: number;
    creatorBuyCount: number;
    creatorSellCount: number;
    topTraders: Array<{
        wallet: string;
        volumeSol: number;
        tradeCount: number;
        volumeShare: number;
        isCreator: boolean;
    }>;
}

interface InternalMarketSnapshot extends MarketSnapshot {
    traderKeys: Set<string>;
    firstObservedPrice: number;
    creatorWallet: string;
    traderVolumes: Map<string, number>;
    traderTradeCounts: Map<string, number>;
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
    const traderTradeCounts = existing?.traderTradeCounts || new Map<string, number>();
    if (token.traderPublicKey && token.traderPublicKey !== 'SIM') {
        traderKeys.add(token.traderPublicKey);
        traderVolumes.set(
            token.traderPublicKey,
            (traderVolumes.get(token.traderPublicKey) || 0) + tradeVolume
        );
        traderTradeCounts.set(
            token.traderPublicKey,
            (traderTradeCounts.get(token.traderPublicKey) || 0) + (token.txType === 'create' ? 0 : 1)
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
    const repeatedTraderCount = [...traderTradeCounts.values()].filter((count) => count > 1).length;

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
        repeatTraderRatio: 0,
        averageTradeSizeSol: 0,
        velocitySolPerMin: 0,
        priceChangePercent: 0,
        maxPriceChangePercent: existing?.maxPriceChangePercent || 0,
        minPriceChangePercent: existing?.minPriceChangePercent || 0,
        peakLiquiditySol: Math.max(existing?.peakLiquiditySol || liquiditySol, liquiditySol),
        peakPrice: Math.max(existing?.peakPrice || currentPrice, currentPrice),
        lastTradeType: token.txType,
        largestTraderVolumeShare,
        topTwoTraderVolumeShare,
        creatorBuyVolumeSol: nextCreatorBuyVolumeSol,
        creatorSellVolumeSol: nextCreatorSellVolumeSol,
        creatorNetFlowSol: nextCreatorBuyVolumeSol - nextCreatorSellVolumeSol,
        creatorVolumeShare: 0,
        creatorBuyCount: nextCreatorBuyCount,
        creatorSellCount: nextCreatorSellCount,
        topTraders: [],
        traderKeys,
        firstObservedPrice: existing?.firstObservedPrice || currentPrice,
        creatorWallet,
        traderVolumes,
        traderTradeCounts
    };

    snapshot.buyPressure = snapshot.observedVolumeSol > 0 ? snapshot.buyVolumeSol / snapshot.observedVolumeSol : 0;
    snapshot.creatorVolumeShare = snapshot.observedVolumeSol > 0
        ? (snapshot.creatorBuyVolumeSol + snapshot.creatorSellVolumeSol) / snapshot.observedVolumeSol
        : 0;
    snapshot.topTraders = [...traderVolumes.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([wallet, volumeSol]) => ({
            wallet,
            volumeSol,
            tradeCount: traderTradeCounts.get(wallet) || 0,
            volumeShare: totalTraderVolume > 0 ? volumeSol / totalTraderVolume : 0,
            isCreator: !!creatorWallet && wallet === creatorWallet
        }));
    snapshot.repeatTraderRatio = snapshot.uniqueTraderCount > 0 ? repeatedTraderCount / snapshot.uniqueTraderCount : 0;
    snapshot.averageTradeSizeSol = snapshot.tradeCount > 0 ? snapshot.observedVolumeSol / snapshot.tradeCount : snapshot.observedVolumeSol;

    const observedMinutes = Math.max((snapshot.lastSeenAt - snapshot.firstSeenAt) / 60_000, 0.05);
    snapshot.velocitySolPerMin = snapshot.observedVolumeSol / observedMinutes;

    if (snapshot.firstObservedPrice > 0 && snapshot.currentPrice > 0) {
        snapshot.priceChangePercent = ((snapshot.currentPrice - snapshot.firstObservedPrice) / snapshot.firstObservedPrice) * 100;
    }
    snapshot.maxPriceChangePercent = Math.max(existing?.maxPriceChangePercent || snapshot.priceChangePercent, snapshot.priceChangePercent);
    snapshot.minPriceChangePercent = Math.min(existing?.minPriceChangePercent || snapshot.priceChangePercent, snapshot.priceChangePercent);

    snapshots.set(token.mint, snapshot);
    return cloneSnapshot(snapshot);
}

export function getMarketSnapshot(mint: string): MarketSnapshot | null {
    const snapshot = snapshots.get(mint);
    return snapshot ? cloneSnapshot(snapshot) : null;
}

export function getAllMarketSnapshots(limit: number = MAX_TRACKED_MINTS): MarketSnapshot[] {
    return [...snapshots.values()]
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .slice(0, Math.max(1, limit))
        .map((snapshot) => cloneSnapshot(snapshot));
}

export function clearMarketSnapshot(mint: string): void {
    snapshots.delete(mint);
}

export function clearAllMarketSnapshots(): void {
    snapshots.clear();
}

// Seed the market snapshot for a token by fetching its recent trades from the
// Pump.fun public API. This is called when the WebSocket trade subscription
// hasn't delivered events yet (snapshot shows 0 trades). Without this, every
// token sits in "early flow snapshot still syncing" forever.
const snapshotSeedInFlight = new Set<string>();

export async function seedMarketSnapshotFromApi(mint: string, creatorWallet?: string): Promise<boolean> {
    // Don't double-fetch
    if (snapshotSeedInFlight.has(mint)) return false;

    const existing = snapshots.get(mint);
    // Already has real trade data — no need to seed
    if (existing && existing.tradeCount >= 2) return false;

    snapshotSeedInFlight.add(mint);
    try {
        const url = `https://frontend-api-v3.pump.fun/trades/all/${mint}?limit=20&minimumSize=0`;
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return false;

        const trades: Array<{
            is_buy: boolean;
            sol_amount: number;
            token_amount: number;
            user: string;
            timestamp: number;
            virtual_sol_reserves?: number;
            virtual_token_reserves?: number;
        }> = await res.json();

        if (!Array.isArray(trades) || trades.length === 0) return false;

        // Replay trades into the snapshot in chronological order
        const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
        for (const trade of sorted) {
            const solAmount = normalizeSolValue(trade.sol_amount);
            if (solAmount <= 0) continue;

            // Build a minimal TokenData-like object for recordMarketEvent
            const fakeToken = {
                mint,
                traderPublicKey: trade.user || '',
                creatorPublicKey: creatorWallet || '',
                txType: trade.is_buy ? 'buy' : 'sell' as 'buy' | 'sell',
                vSolInBondingCurve: trade.virtual_sol_reserves ? normalizeSolValue(trade.virtual_sol_reserves) : 0,
                vTokensInBondingCurve: trade.virtual_token_reserves || 0,
                initialBuy: 0,
                bondingCurveKey: '',
                marketCapSol: 0,
                name: existing?.name || '',
                symbol: existing?.symbol || '',
                uri: '',
                timestamp: trade.timestamp * 1000,
            };
            recordMarketEvent(fakeToken as any);
        }

        return true;
    } catch {
        return false;
    } finally {
        snapshotSeedInFlight.delete(mint);
    }
}
