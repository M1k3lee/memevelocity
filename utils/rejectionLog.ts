/**
 * Structured rejection telemetry.
 *
 * Before this module existed, rejection logs were gated on
 * `token.txType === 'create'` so only the very first event for each mint ever
 * printed a reason. Tokens that came in via subsequent trade events — which is
 * the majority — were silently dropped. After 5 hours of running and zero
 * trades, the operator (Mike) had no way to tell if (a) the bot wasn't seeing
 * tokens, (b) the rug detector was killing them, (c) the analyzer was killing
 * them, (d) the live guard was killing them, or (e) the confirmation window
 * was killing them.
 *
 * This module fixes that by:
 *   - Recording every gate decision with mode + gate + bucketed reason.
 *   - Periodically (every ~60s) printing a summary so the operator can see at
 *     a glance which gate is the bottleneck and shift mode/preset accordingly.
 *   - Keeping the per-event console noise low by only logging individual
 *     rejections at INFO once, on the first occurrence per mint+gate, and
 *     leaving rolling counts to the summary.
 */

export type RejectGate =
    | 'rug-detector'
    | 'analyzer'
    | 'live-guard'
    | 'confirmation'
    | 'risk-rail'
    | 'budget';

export type RejectStatus = 'reject' | 'wait' | 'pass';

interface BucketCounts {
    [bucket: string]: number;
}

interface ModeBucket {
    [gate: string]: BucketCounts;
}

const counters: Record<string, ModeBucket> = {};
const passCounts: Record<string, number> = {};
let totalSeen = 0;
let lastSummaryAt = Date.now();
const seenMintGate = new Map<string, number>();
const SUMMARY_INTERVAL_MS = 60_000;
const FIRST_SEEN_TTL_MS = 10 * 60_000;

/**
 * Bucket a freeform reason string into a coarse category so the summary stays
 * readable. We stay deliberately generous with the buckets — the goal is "what
 * class of issue is killing my entries" not "every variant of the message".
 */
export function bucketReason(reason: string | undefined): string {
    if (!reason) return 'other';
    const r = reason.toLowerCase();

    if (r.includes('creator') && (r.includes('sold') || r.includes('sell'))) return 'creator-sell';
    if (r.includes('creator') && r.includes('flow')) return 'creator-flow';
    if (r.includes('rug') || r.includes('honeypot')) return 'rug-pattern';
    if (r.includes('liquidity')) return 'liquidity';
    if (r.includes('freeze') || r.includes('mint authority') || r.includes('authority')) return 'authority';
    if (r.includes('metadata') || r.includes('symbol') || r.includes('name')) return 'metadata';
    if (r.includes('tier 0')) return 'tier0';
    if (r.includes('tier 2') || r.includes('distribution') || r.includes('top 10') || r.includes('concentration')) return 'distribution';
    if (r.includes('tier 4') || r.includes('curve')) return 'curve';
    if (r.includes('post-peak') || r.includes('extended') || r.includes('late')) return 'late-chase';
    if (r.includes('shakeout') || r.includes('absorb') || r.includes('one-sided') || r.includes('coordinated')) return 'no-shakeout';
    if (r.includes('one wallet') || r.includes('top 2 wallet') || r.includes('largest')) return 'wallet-concentration';
    if (r.includes('repeat')) return 'repeat-traders';
    if (r.includes('buy pressure') || r.includes('buy_pressure') || r.includes('buypressure')) return 'buy-pressure';
    if (r.includes('net flow') || r.includes('netflow')) return 'net-flow';
    if (r.includes('observed') || r.includes('volume')) return 'volume';
    if (r.includes('trades') || r.includes('wallets')) return 'tape-not-ready';
    if (r.includes('confirmation') || r.includes('confirm')) return 'confirmation-fade';
    if (r.includes('impact')) return 'curve-impact';
    if (r.includes('window') || r.includes('age')) return 'age-window';
    if (r.includes('balance') || r.includes('budget')) return 'budget';
    if (r.includes('paused') || r.includes('circuit') || r.includes('daily')) return 'risk-rail';
    if (r.includes('score')) return 'composite-score';
    if (r.includes('launch flag') || r.includes('incentive') || r.includes('pump launch')) return 'pump-flag';
    if (r.includes('post-peak')) return 'late-chase';
    return 'other';
}

export function recordSeenToken(): void {
    totalSeen += 1;
    maybeFlushSummary();
}

export function recordEntryDecision(params: {
    mode: string;
    gate: RejectGate;
    status: RejectStatus;
    reason?: string;
    mint: string;
    symbol?: string;
    log: (line: string) => void;
}): void {
    const { mode, gate, status, reason, mint, log } = params;
    const key = `${mode}|${gate}`;
    if (!counters[key]) counters[key] = {};
    if (!counters[key][gate]) counters[key][gate] = {};

    if (status === 'pass') {
        passCounts[mode] = (passCounts[mode] || 0) + 1;
        maybeFlushSummary();
        return;
    }

    const bucket = bucketReason(reason);
    const statusBucket = status === 'wait' ? `wait:${bucket}` : `reject:${bucket}`;
    counters[key][gate][statusBucket] = (counters[key][gate][statusBucket] || 0) + 1;

    // First-occurrence-per-mint-gate INFO log so Mike can see something is
    // happening on real tokens. Subsequent occurrences roll into the summary.
    const fingerprint = `${mint}|${gate}|${status}|${bucket}`;
    const now = Date.now();
    pruneFirstSeen(now);
    if (!seenMintGate.has(fingerprint)) {
        seenMintGate.set(fingerprint, now);
        const symbol = params.symbol ? params.symbol.padEnd(10) : 'unknown';
        const reasonText = reason ? ` ${reason}` : '';
        log(`[${gate}] ${status.toUpperCase()} ${symbol} (${mode}):${reasonText}`);
    }

    maybeFlushSummary();
}

function pruneFirstSeen(now: number): void {
    if (seenMintGate.size < 2000) return;
    for (const [key, ts] of seenMintGate.entries()) {
        if ((now - ts) > FIRST_SEEN_TTL_MS) {
            seenMintGate.delete(key);
        }
    }
}

function maybeFlushSummary(): void {
    const now = Date.now();
    if ((now - lastSummaryAt) < SUMMARY_INTERVAL_MS) return;
    flushSummary();
}

export function flushSummary(log: (line: string) => void = console.log): void {
    const now = Date.now();
    const elapsedMin = Math.max(1, (now - lastSummaryAt) / 60_000);
    const summary: string[] = [];

    summary.push(`Entry telemetry (last ${elapsedMin.toFixed(1)}m): saw ${totalSeen} tokens`);

    const passEntries = Object.entries(passCounts);
    if (passEntries.length > 0) {
        const passSummary = passEntries.map(([mode, count]) => `${mode}=${count}`).join(', ');
        summary.push(`  Passes: ${passSummary}`);
    } else {
        summary.push(`  Passes: none`);
    }

    const aggregated = new Map<string, Map<string, number>>();
    for (const [key, gateBuckets] of Object.entries(counters)) {
        const [mode, gate] = key.split('|');
        const flatKey = `${mode}|${gate}`;
        if (!aggregated.has(flatKey)) aggregated.set(flatKey, new Map());
        const acc = aggregated.get(flatKey)!;
        for (const buckets of Object.values(gateBuckets)) {
            for (const [bucket, count] of Object.entries(buckets)) {
                acc.set(bucket, (acc.get(bucket) || 0) + count);
            }
        }
    }

    if (aggregated.size === 0) {
        summary.push(`  Rejections: none recorded`);
    } else {
        const sortedKeys = [...aggregated.keys()].sort();
        for (const key of sortedKeys) {
            const buckets = aggregated.get(key)!;
            const top = [...buckets.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([bucket, count]) => `${bucket}=${count}`)
                .join(', ');
            summary.push(`  ${key}: ${top}`);
        }
    }

    for (const line of summary) {
        log(line);
    }

    Object.keys(counters).forEach((k) => delete counters[k]);
    Object.keys(passCounts).forEach((k) => delete passCounts[k]);
    totalSeen = 0;
    lastSummaryAt = now;
}

export function resetRejectionTelemetry(): void {
    Object.keys(counters).forEach((k) => delete counters[k]);
    Object.keys(passCounts).forEach((k) => delete passCounts[k]);
    seenMintGate.clear();
    totalSeen = 0;
    lastSummaryAt = Date.now();
}
