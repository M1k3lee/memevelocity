import fs from 'fs';
import path from 'path';
import type { TokenData } from '../types/token';
import { clearAllMarketSnapshots, getMarketSnapshot, recordMarketEvent } from '../utils/marketData';
import { calculateBondingCurveProgress } from '../utils/pumpMath';
import { normalizeTokenEvent } from '../utils/tokenFeed';

export type ReplayTapeEvent = {
    t: number;
    txType: TokenData['txType'];
    trader: string;
    liquiditySol: number;
    progress: number;
    initialBuy?: number;
};

export type ReplayScenario = {
    id: string;
    description: string;
    creator: string;
    quality: {
        holderCount: number;
        deployerHoldings: number;
        top10Concentration: number;
    };
    events: ReplayTapeEvent[];
    source?: 'synthetic' | 'capture';
    outcomeLabel?: string;
    capturePath?: string;
};

type ParsedCaptureRecord = {
    capturedAt: number;
    token: TokenData;
};

function parseCaptureLine(line: string): ParsedCaptureRecord | null {
    if (!line.trim()) return null;

    try {
        const parsed = JSON.parse(line);
        const capturedAt = parsed.capturedAt ? Date.parse(parsed.capturedAt) : Date.now();

        if (parsed.type === 'event' && parsed.normalized?.mint) {
            return {
                capturedAt,
                token: parsed.normalized as TokenData
            };
        }

        if (parsed.payload?.mint) {
            return {
                capturedAt,
                token: normalizeTokenEvent(parsed.payload, capturedAt)
            };
        }

        if (parsed.raw?.mint) {
            return {
                capturedAt,
                token: normalizeTokenEvent(parsed.raw, capturedAt)
            };
        }
    } catch {
        return null;
    }

    return null;
}

function estimateQualityFromSnapshot(snapshot: ReturnType<typeof getMarketSnapshot>): ReplayScenario['quality'] {
    if (!snapshot) {
        return {
            holderCount: 10,
            deployerHoldings: -1,
            top10Concentration: 55
        };
    }

    const holderCount = Math.max(
        snapshot.uniqueTraderCount,
        Math.round(snapshot.uniqueTraderCount * 1.2),
        snapshot.observedVolumeSol >= 3 ? 12 : 0
    );
    const deployerHoldings = snapshot.creatorSellCount > 0
        ? Math.min(18, Math.max(4, snapshot.creatorVolumeShare * 24))
        : Math.max(2, snapshot.creatorVolumeShare * 16);
    const top10Concentration = Math.max(
        16,
        Math.min(
            78,
            Math.round(
                (snapshot.largestTraderVolumeShare * 45) +
                (snapshot.topTwoTraderVolumeShare * 28) +
                (snapshot.repeatTraderRatio * 18) +
                10
            )
        )
    );

    return {
        holderCount,
        deployerHoldings: Number(deployerHoldings.toFixed(1)),
        top10Concentration
    };
}

function labelOutcome(snapshot: ReturnType<typeof getMarketSnapshot>): { label: string; description: string } {
    if (!snapshot) {
        return {
            label: 'unknown',
            description: 'Capture did not have enough market history to classify.'
        };
    }

    if (snapshot.creatorSellCount > 0 && snapshot.maxPriceChangePercent >= 10) {
        return {
            label: 'creator-exit',
            description: `Creator selling appeared during the launch (${snapshot.creatorSellCount} sells, peak ${snapshot.maxPriceChangePercent.toFixed(1)}%).`
        };
    }

    if (snapshot.maxPriceChangePercent >= 35 && snapshot.peakLiquiditySol >= 34 && snapshot.netFlowSol > 0) {
        return {
            label: 'breakout',
            description: `Captured launch broke out cleanly (peak ${snapshot.maxPriceChangePercent.toFixed(1)}%, ${snapshot.tradeCount} trades).`
        };
    }

    if (snapshot.maxPriceChangePercent >= 18 && snapshot.peakLiquiditySol >= 32.5 && snapshot.netFlowSol > 0.5) {
        return {
            label: 'continuation',
            description: `Captured launch showed a tradeable continuation (peak ${snapshot.maxPriceChangePercent.toFixed(1)}%, net flow ${snapshot.netFlowSol.toFixed(2)} SOL).`
        };
    }

    const drawdownFromPeak = snapshot.maxPriceChangePercent - snapshot.priceChangePercent;
    if (snapshot.maxPriceChangePercent >= 12 && drawdownFromPeak >= 20) {
        return {
            label: 'ruggy',
            description: `Captured launch reversed hard after the early move (peak ${snapshot.maxPriceChangePercent.toFixed(1)}%, now ${snapshot.priceChangePercent.toFixed(1)}%).`
        };
    }

    if (snapshot.maxPriceChangePercent <= 8 && snapshot.netFlowSol <= 1.2) {
        return {
            label: 'dead',
            description: `Captured launch never built enough displacement (peak ${snapshot.maxPriceChangePercent.toFixed(1)}%, net flow ${snapshot.netFlowSol.toFixed(2)} SOL).`
        };
    }

    return {
        label: 'stall',
        description: `Captured launch printed activity but stalled (peak ${snapshot.maxPriceChangePercent.toFixed(1)}%, current ${snapshot.priceChangePercent.toFixed(1)}%).`
    };
}

function tokenToReplayEvent(token: TokenData, launchTime: number): ReplayTapeEvent {
    const eventTime = token.lastSeenAt || token.createdAt || token.timestamp;
    return {
        t: Math.max(0, Math.round((eventTime - launchTime) / 1000)),
        txType: token.txType,
        trader: token.traderPublicKey || 'unknown',
        liquiditySol: token.vSolInBondingCurve,
        progress: calculateBondingCurveProgress(token.vTokensInBondingCurve),
        initialBuy: token.initialBuy > 0 ? token.initialBuy : undefined
    };
}

export function resolveCapturePath(input?: string): string | null {
    if (input && input !== '--latest-capture') {
        const resolved = path.resolve(process.cwd(), input);
        return fs.existsSync(resolved) ? resolved : null;
    }

    const captureDir = path.resolve(process.cwd(), 'runtime', 'captures');
    if (!fs.existsSync(captureDir)) {
        return null;
    }

    const latest = fs.readdirSync(captureDir)
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => ({
            file,
            mtime: fs.statSync(path.join(captureDir, file)).mtimeMs
        }))
        .sort((a, b) => b.mtime - a.mtime)[0];

    return latest ? path.join(captureDir, latest.file) : null;
}

export function loadCaptureReplayScenarios(capturePath: string, maxLaunches: number = 80): ReplayScenario[] {
    const raw = fs.readFileSync(capturePath, 'utf8');
    const parsed = raw
        .split(/\r?\n/)
        .map(parseCaptureLine)
        .filter((value): value is ParsedCaptureRecord => !!value)
        .sort((a, b) => a.capturedAt - b.capturedAt);

    const grouped = new Map<string, ParsedCaptureRecord[]>();
    for (const entry of parsed) {
        if (!grouped.has(entry.token.mint)) {
            grouped.set(entry.token.mint, []);
        }
        grouped.get(entry.token.mint)?.push(entry);
    }

    const scenarios: ReplayScenario[] = [];

    for (const [mint, records] of grouped.entries()) {
        const createRecord = records.find((record) => record.token.txType === 'create') || records[0];
        if (!createRecord) continue;

        const launchTime = createRecord.token.createdAt || createRecord.token.timestamp || createRecord.capturedAt;
        const creator = createRecord.token.creatorPublicKey || createRecord.token.traderPublicKey || 'unknown';
        const windowedRecords = records
            .filter((record) => {
                const eventTime = record.token.lastSeenAt || record.token.createdAt || record.token.timestamp || record.capturedAt;
                return eventTime >= launchTime && eventTime <= (launchTime + 300_000);
            })
            .slice(0, 80);

        if (windowedRecords.length < 6) {
            continue;
        }

        clearAllMarketSnapshots();
        for (const record of windowedRecords) {
            recordMarketEvent(record.token);
        }
        const snapshot = getMarketSnapshot(mint);
        const quality = estimateQualityFromSnapshot(snapshot);
        const outcome = labelOutcome(snapshot);

        const events = windowedRecords
            .map((record) => tokenToReplayEvent(record.token, launchTime))
            .filter((event, index, allEvents) => index === 0 || event.t !== allEvents[index - 1].t || event.txType !== allEvents[index - 1].txType);

        scenarios.push({
            id: `${createRecord.token.symbol || 'token'}-${mint.slice(0, 6)}`.toLowerCase(),
            description: outcome.description,
            creator,
            quality,
            events,
            source: 'capture',
            outcomeLabel: outcome.label,
            capturePath
        });
    }

    clearAllMarketSnapshots();

    return scenarios
        .sort((a, b) => (b.events.length - a.events.length))
        .slice(0, maxLaunches);
}
