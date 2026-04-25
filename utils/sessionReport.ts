/**
 * Session-scoped telemetry and end-of-run report.
 *
 * Why this module exists:
 *
 * `BotState.totals` is *cumulative across every run* — it's persisted to
 * `bot-state.json` and never reset, so it's useless for answering "how did
 * this session go?". `utils/rejectionLog.ts` does periodic 60s flushes that
 * also reset their counters, so once the operator has run for a few hours
 * they can't see the *whole-session* shape of what got rejected.
 *
 * After a 5-hour live run that took zero trades, Mike (the operator) had
 * no structured way to see:
 *   - How many tokens were observed this session
 *   - Which gate ate the most candidates
 *   - How many candidates passed every gate but failed to fill
 *   - PnL by mode, win rate, avg win/loss, biggest win/loss
 *   - Average / max hold time
 *   - Distribution of close reasons
 *
 * This module solves that by:
 *   - Owning a session-scoped event log that doesn't reset on flushes.
 *   - Pulling whole-session rejection totals from rejectionLog (which now
 *     tracks them separately from the periodic-flush counters).
 *   - Producing a single structured report at shutdown that is logged to
 *     console and written to disk as JSON for cross-session diffing.
 *
 * The goal is not to replace the periodic 60s telemetry — that's still the
 * right thing for "what's happening *right now*". This is for "what did
 * this whole session look like?".
 */
import fs from 'fs/promises';
import path from 'path';
import type { ManagedPosition } from '../bot/types';
import { getSessionTelemetry } from './rejectionLog';

export interface BuyAttemptEvent {
    kind: 'attempt';
    at: number;
    mint: string;
    symbol: string;
    mode: string;
    amountSol: number;
    analysisScore?: number;
    riskLevel?: string;
}

export interface BuyFillEvent {
    kind: 'fill';
    at: number;
    mint: string;
    symbol: string;
    mode: string;
    amountSol: number;
    fillPrice: number;
    isDryRun: boolean;
    txId?: string;
}

export interface BuyFailureEvent {
    kind: 'fail';
    at: number;
    mint: string;
    symbol: string;
    mode: string;
    reason: string;
}

export interface PositionCloseEvent {
    kind: 'close';
    at: number;
    mint: string;
    symbol: string;
    mode: string;
    closeReason: string;
    realizedProfitSol: number;
    holdSeconds: number;
    isDryRun: boolean;
    pnlPercent: number | null;
}

export type SessionEvent = BuyAttemptEvent | BuyFillEvent | BuyFailureEvent | PositionCloseEvent;

interface SessionState {
    startedAt: number;
    mode: string;
    walletAddress: string | null;
    startingBalanceSol: number | null;
    isDryRun: boolean;
    events: SessionEvent[];
}

let session: SessionState = createEmptySession();

function createEmptySession(): SessionState {
    return {
        startedAt: Date.now(),
        mode: 'unknown',
        walletAddress: null,
        startingBalanceSol: null,
        isDryRun: true,
        events: []
    };
}

export function startSession(params: {
    mode: string;
    walletAddress: string | null;
    startingBalanceSol: number | null;
    isDryRun: boolean;
}): void {
    session = {
        ...createEmptySession(),
        startedAt: Date.now(),
        mode: params.mode,
        walletAddress: params.walletAddress,
        startingBalanceSol: params.startingBalanceSol,
        isDryRun: params.isDryRun
    };
}

export function recordBuyAttempt(params: Omit<BuyAttemptEvent, 'kind' | 'at'>): void {
    session.events.push({ kind: 'attempt', at: Date.now(), ...params });
}

export function recordBuyFill(params: Omit<BuyFillEvent, 'kind' | 'at'>): void {
    session.events.push({ kind: 'fill', at: Date.now(), ...params });
}

export function recordBuyFailure(params: Omit<BuyFailureEvent, 'kind' | 'at'>): void {
    session.events.push({ kind: 'fail', at: Date.now(), ...params });
}

export function recordPositionClose(params: {
    position: ManagedPosition;
    mode: string;
    closeReason: string;
    isDryRun: boolean;
}): void {
    const { position, mode, closeReason, isDryRun } = params;
    const closeTime = position.closeTime || Date.now();
    const holdSeconds = Math.max(0, (closeTime - position.buyTime) / 1000);
    const pnlPercent = position.amountSolPaid > 0
        ? (position.realizedProfitSol / position.amountSolPaid) * 100
        : null;
    session.events.push({
        kind: 'close',
        at: closeTime,
        mint: position.mint,
        symbol: position.symbol,
        mode,
        closeReason,
        realizedProfitSol: position.realizedProfitSol,
        holdSeconds,
        isDryRun,
        pnlPercent
    });
}

export interface SessionReport {
    generatedAt: number;
    startedAt: number;
    durationMin: number;
    mode: string;
    isDryRun: boolean;
    walletAddress: string | null;
    startingBalanceSol: number | null;
    activity: {
        tokensSeen: number;
        modePassCounts: Record<string, number>;
        attempts: number;
        fills: number;
        failures: number;
        closes: number;
        openAtShutdown: number;
    };
    pnl: {
        realizedProfitSol: number;
        wins: number;
        losses: number;
        winRate: number;
        avgWinSol: number;
        avgLossSol: number;
        biggestWinSol: number;
        biggestLossSol: number;
    };
    holdTime: {
        avgHoldSeconds: number;
        medianHoldSeconds: number;
        maxHoldSeconds: number;
    };
    pnlByMode: Record<string, { trades: number; realizedSol: number; winRate: number }>;
    closeReasonCounts: Array<{ reason: string; count: number; realizedSol: number }>;
    rejectionBuckets: Array<{ key: string; bucket: string; count: number }>;
    notableEvents: {
        biggestWin: PositionCloseEvent | null;
        biggestLoss: PositionCloseEvent | null;
        recentFailures: BuyFailureEvent[];
    };
    insights: string[];
    openPositionsAtShutdown: Array<{ mint: string; symbol: string; mode: string; ageSeconds: number }>;
}

export function buildSessionReport(params: {
    openPositions: ManagedPosition[];
    runnerMode: string;
    isDryRun: boolean;
} = { openPositions: [], runnerMode: session.mode, isDryRun: session.isDryRun }): SessionReport {
    const now = Date.now();
    const durationMin = Math.max(0, (now - session.startedAt) / 60_000);

    const closes = session.events.filter((e): e is PositionCloseEvent => e.kind === 'close');
    const fills = session.events.filter((e): e is BuyFillEvent => e.kind === 'fill');
    const attempts = session.events.filter((e): e is BuyAttemptEvent => e.kind === 'attempt');
    const failures = session.events.filter((e): e is BuyFailureEvent => e.kind === 'fail');

    const wins = closes.filter((e) => e.realizedProfitSol > 0);
    const losses = closes.filter((e) => e.realizedProfitSol <= 0);
    const realizedProfitSol = closes.reduce((sum, e) => sum + e.realizedProfitSol, 0);
    const avgWinSol = wins.length > 0 ? wins.reduce((sum, e) => sum + e.realizedProfitSol, 0) / wins.length : 0;
    const avgLossSol = losses.length > 0 ? losses.reduce((sum, e) => sum + e.realizedProfitSol, 0) / losses.length : 0;
    const biggestWinEvent = wins.length > 0 ? wins.reduce((best, e) => e.realizedProfitSol > best.realizedProfitSol ? e : best) : null;
    const biggestLossEvent = losses.length > 0 ? losses.reduce((worst, e) => e.realizedProfitSol < worst.realizedProfitSol ? e : worst) : null;

    const holdSeconds = closes.map((e) => e.holdSeconds).sort((a, b) => a - b);
    const avgHoldSeconds = holdSeconds.length > 0
        ? holdSeconds.reduce((sum, h) => sum + h, 0) / holdSeconds.length
        : 0;
    const medianHoldSeconds = holdSeconds.length > 0
        ? holdSeconds[Math.floor(holdSeconds.length / 2)]
        : 0;
    const maxHoldSeconds = holdSeconds.length > 0 ? holdSeconds[holdSeconds.length - 1] : 0;

    const pnlByModeMap = new Map<string, { trades: number; realizedSol: number; wins: number }>();
    for (const close of closes) {
        const entry = pnlByModeMap.get(close.mode) || { trades: 0, realizedSol: 0, wins: 0 };
        entry.trades += 1;
        entry.realizedSol += close.realizedProfitSol;
        if (close.realizedProfitSol > 0) entry.wins += 1;
        pnlByModeMap.set(close.mode, entry);
    }
    const pnlByMode: Record<string, { trades: number; realizedSol: number; winRate: number }> = {};
    for (const [mode, entry] of pnlByModeMap.entries()) {
        pnlByMode[mode] = {
            trades: entry.trades,
            realizedSol: entry.realizedSol,
            winRate: entry.trades > 0 ? entry.wins / entry.trades : 0
        };
    }

    const closeReasonMap = new Map<string, { count: number; realizedSol: number }>();
    for (const close of closes) {
        const entry = closeReasonMap.get(close.closeReason) || { count: 0, realizedSol: 0 };
        entry.count += 1;
        entry.realizedSol += close.realizedProfitSol;
        closeReasonMap.set(close.closeReason, entry);
    }
    const closeReasonCounts = [...closeReasonMap.entries()]
        .map(([reason, entry]) => ({ reason, count: entry.count, realizedSol: entry.realizedSol }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

    const telemetry = getSessionTelemetry();
    const rejectionBuckets: Array<{ key: string; bucket: string; count: number }> = [];
    for (const [key, buckets] of Object.entries(telemetry.gateBuckets)) {
        for (const [bucket, count] of Object.entries(buckets)) {
            rejectionBuckets.push({ key, bucket, count });
        }
    }
    rejectionBuckets.sort((a, b) => b.count - a.count);

    const recentFailures = failures.slice(-10);

    const openPositionsAtShutdown = params.openPositions.map((position) => ({
        mint: position.mint,
        symbol: position.symbol,
        // ManagedPosition doesn't carry the entry mode today (the runner
        // only operates in one mode at a time, so the session's mode is a
        // safe fallback). If we ever support per-position modes, persist
        // the mode at buy time and read it here.
        mode: session.mode,
        ageSeconds: Math.max(0, (now - position.buyTime) / 1000)
    }));

    const insights = generateInsights({
        tokensSeen: telemetry.tokensSeen,
        modePassCounts: telemetry.modePassCounts,
        attempts: attempts.length,
        fills: fills.length,
        failures: failures.length,
        closes: closes.length,
        rejectionBuckets,
        durationMin,
        realizedProfitSol,
        wins: wins.length,
        losses: losses.length
    });

    return {
        generatedAt: now,
        startedAt: session.startedAt,
        durationMin,
        mode: session.mode,
        isDryRun: session.isDryRun,
        walletAddress: session.walletAddress,
        startingBalanceSol: session.startingBalanceSol,
        activity: {
            tokensSeen: telemetry.tokensSeen,
            modePassCounts: telemetry.modePassCounts,
            attempts: attempts.length,
            fills: fills.length,
            failures: failures.length,
            closes: closes.length,
            openAtShutdown: openPositionsAtShutdown.length
        },
        pnl: {
            realizedProfitSol,
            wins: wins.length,
            losses: losses.length,
            winRate: closes.length > 0 ? wins.length / closes.length : 0,
            avgWinSol,
            avgLossSol,
            biggestWinSol: biggestWinEvent?.realizedProfitSol || 0,
            biggestLossSol: biggestLossEvent?.realizedProfitSol || 0
        },
        holdTime: {
            avgHoldSeconds,
            medianHoldSeconds,
            maxHoldSeconds
        },
        pnlByMode,
        closeReasonCounts,
        rejectionBuckets: rejectionBuckets.slice(0, 25),
        notableEvents: {
            biggestWin: biggestWinEvent,
            biggestLoss: biggestLossEvent,
            recentFailures
        },
        insights,
        openPositionsAtShutdown
    };
}

function generateInsights(input: {
    tokensSeen: number;
    modePassCounts: Record<string, number>;
    attempts: number;
    fills: number;
    failures: number;
    closes: number;
    rejectionBuckets: Array<{ key: string; bucket: string; count: number }>;
    durationMin: number;
    realizedProfitSol: number;
    wins: number;
    losses: number;
}): string[] {
    const insights: string[] = [];
    const totalPasses = Object.values(input.modePassCounts).reduce((sum, n) => sum + n, 0);

    if (input.tokensSeen === 0) {
        insights.push('No tokens were observed. Check the PumpPortal feed connection.');
        return insights;
    }

    if (input.fills === 0 && input.tokensSeen > 50) {
        insights.push(`Saw ${input.tokensSeen} tokens but filled zero buys. Check the top rejection bucket below for the limiting gate.`);
    }

    if (totalPasses > 0 && input.fills < totalPasses) {
        const slip = totalPasses - input.fills;
        insights.push(`${slip} candidates passed every gate but did not fill. Investigate executeBuy slippage / balance / RPC errors.`);
    }

    if (input.failures > 0) {
        insights.push(`${input.failures} buy attempts errored. See "Recent failures" for the most recent reasons.`);
    }

    if (input.closes >= 5 && input.wins > 0 && input.losses > 0) {
        const winRate = input.wins / input.closes;
        if (winRate < 0.3) {
            insights.push(`Win rate is ${(winRate * 100).toFixed(0)}% over ${input.closes} closes. Consider tightening entry quality (higher score floor or stricter gates).`);
        }
    }

    if (input.realizedProfitSol < 0 && input.closes >= 3) {
        insights.push(`Net PnL negative across ${input.closes} closed trades. Pull the close-reason distribution to see which exit type is bleeding the most.`);
    }

    const top = input.rejectionBuckets[0];
    if (top && top.count > 5 && input.fills < 5) {
        insights.push(`Top rejection bucket: ${top.key} -> ${top.bucket} (${top.count}). If this looks too strict for your mode, that's the first dial to loosen.`);
    }

    if (input.durationMin >= 30 && input.tokensSeen / Math.max(1, input.durationMin) < 0.5) {
        insights.push(`Token-discovery rate is low (${(input.tokensSeen / Math.max(1, input.durationMin)).toFixed(1)} tokens/min). The PumpPortal feed may have been disconnected for parts of the session.`);
    }

    return insights;
}

export function formatSessionReport(report: SessionReport): string {
    const lines: string[] = [];
    const dur = report.durationMin >= 60
        ? `${(report.durationMin / 60).toFixed(1)}h`
        : `${report.durationMin.toFixed(1)}m`;

    lines.push('');
    lines.push('================ SESSION REPORT ================');
    lines.push(`Mode: ${report.mode}${report.isDryRun ? ' (dry-run)' : ' (live)'}  Duration: ${dur}`);
    if (report.walletAddress) lines.push(`Wallet: ${report.walletAddress}`);
    if (report.startingBalanceSol !== null) lines.push(`Starting balance: ${report.startingBalanceSol.toFixed(4)} SOL`);
    lines.push('');

    lines.push('-- Activity --');
    lines.push(`  Tokens seen:        ${report.activity.tokensSeen}`);
    const passSummary = Object.entries(report.activity.modePassCounts)
        .map(([mode, count]) => `${mode}=${count}`).join(', ') || 'none';
    lines.push(`  Gate passes:        ${passSummary}`);
    lines.push(`  Buy attempts:       ${report.activity.attempts}`);
    lines.push(`  Buys filled:        ${report.activity.fills}`);
    lines.push(`  Buy failures:       ${report.activity.failures}`);
    lines.push(`  Positions closed:   ${report.activity.closes}`);
    lines.push(`  Open at shutdown:   ${report.activity.openAtShutdown}`);
    lines.push('');

    if (report.activity.closes > 0) {
        lines.push('-- PnL --');
        lines.push(`  Realized:           ${report.pnl.realizedProfitSol.toFixed(4)} SOL`);
        lines.push(`  Win / Loss:         ${report.pnl.wins} / ${report.pnl.losses}  (${(report.pnl.winRate * 100).toFixed(0)}%)`);
        lines.push(`  Avg win / loss:     ${report.pnl.avgWinSol.toFixed(4)} / ${report.pnl.avgLossSol.toFixed(4)} SOL`);
        lines.push(`  Biggest win / loss: ${report.pnl.biggestWinSol.toFixed(4)} / ${report.pnl.biggestLossSol.toFixed(4)} SOL`);
        lines.push('');

        lines.push('-- Hold time --');
        lines.push(`  Avg / median / max: ${report.holdTime.avgHoldSeconds.toFixed(0)}s / ${report.holdTime.medianHoldSeconds.toFixed(0)}s / ${report.holdTime.maxHoldSeconds.toFixed(0)}s`);
        lines.push('');

        if (Object.keys(report.pnlByMode).length > 1) {
            lines.push('-- PnL by mode --');
            for (const [mode, stats] of Object.entries(report.pnlByMode)) {
                lines.push(`  ${mode.padEnd(10)} trades=${stats.trades}  realized=${stats.realizedSol.toFixed(4)} SOL  win-rate=${(stats.winRate * 100).toFixed(0)}%`);
            }
            lines.push('');
        }

        if (report.closeReasonCounts.length > 0) {
            lines.push('-- Top close reasons --');
            for (const entry of report.closeReasonCounts) {
                lines.push(`  ${entry.reason.padEnd(28)} count=${entry.count}  realized=${entry.realizedSol.toFixed(4)} SOL`);
            }
            lines.push('');
        }
    }

    if (report.rejectionBuckets.length > 0) {
        lines.push('-- Top rejection buckets (whole session) --');
        for (const entry of report.rejectionBuckets.slice(0, 12)) {
            lines.push(`  ${entry.key.padEnd(28)} ${entry.bucket.padEnd(28)} ${entry.count}`);
        }
        lines.push('');
    }

    if (report.notableEvents.recentFailures.length > 0) {
        lines.push('-- Recent buy failures --');
        for (const failure of report.notableEvents.recentFailures) {
            lines.push(`  ${failure.symbol.padEnd(10)} ${failure.mode.padEnd(8)} ${failure.reason}`);
        }
        lines.push('');
    }

    if (report.openPositionsAtShutdown.length > 0) {
        lines.push('-- Open positions at shutdown --');
        for (const pos of report.openPositionsAtShutdown) {
            lines.push(`  ${pos.symbol.padEnd(10)} ${pos.mode.padEnd(10)} age=${pos.ageSeconds.toFixed(0)}s  mint=${pos.mint}`);
        }
        lines.push('');
    }

    if (report.insights.length > 0) {
        lines.push('-- Insights --');
        for (const insight of report.insights) {
            lines.push(`  - ${insight}`);
        }
        lines.push('');
    }

    lines.push('=================================================');
    return lines.join('\n');
}

export async function writeSessionReport(filePath: string, report: SessionReport): Promise<void> {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(report, null, 2), 'utf8');
}

export function defaultSessionReportPath(stateDir: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(stateDir, 'session-reports', `session-${stamp}.json`);
}

// Test/debug only: clear all session state.
export function resetSessionReport(): void {
    session = createEmptySession();
}

export function getSessionStartedAt(): number {
    return session.startedAt;
}

export function getSessionEventCount(): number {
    return session.events.length;
}
