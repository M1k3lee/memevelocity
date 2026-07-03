import WebSocket from 'ws';
import { clearTokenBalanceCache, closeEmptyTokenAccounts, createConnection, getBalance, getPumpData, getTokenBalance } from '../utils/solanaManager';
import { getTradeTransaction, signAndSendTransaction } from '../utils/pumpPortal';
import { detectRug } from '../utils/rugDetector';
import { analyzeEnhanced, type EnhancedAnalysis } from '../utils/enhancedAnalyzer';
import { clearMarketSnapshot, getMarketSnapshot, recordMarketEvent } from '../utils/marketData';
import { evaluateLiveEntryGuard } from '../utils/liveEntryGuard';
import { mergeTokenData, normalizeTokenEvent } from '../utils/tokenFeed';
import { getConfiguredWallet, loadRunnerConfig } from './config';
import { loadState, saveState } from './stateStore';
import type { TokenData } from '../types/token';
import type { BotMode, BotState, ManagedExitStrategy, ManagedPosition, RunnerConfig } from './types';
import { calculatePumpPrice } from '../utils/pumpMath';
import {
    estimatePaperBuyExecution,
    estimatePaperSellExecution,
    PAPER_TOKEN_ACCOUNT_RENT_SOL
} from '../utils/paperTrading';
import {
    getProfitLockFloor,
    getRunnerActivationProfit,
    getRunnerMaxHoldTime,
    getRunnerTimeExitFloor,
    getRunnerTrailingStopPercent,
    getTp1SellPercent,
    getTp2SellPercent,
    hasTp1Sell
} from '../utils/tradeExit';
import { computeDynamicBuySlippage, computeDynamicSellSlippage } from '../utils/slippageModel';
import { flushSummary as flushRejectionSummary, recordEntryDecision, recordSeenToken, resetRejectionTelemetry } from '../utils/rejectionLog';
import {
    buildSessionReport,
    defaultSessionReportPath,
    formatSessionReport,
    recordBuyAttempt,
    recordBuyFailure,
    recordBuyFill,
    recordPositionClose,
    startSession,
    writeSessionReport
} from '../utils/sessionReport';
import path from 'path';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPercent(percent: number): number {
    return Math.max(0, Math.min(100, percent));
}

function calculatePrice(liquiditySol: number, virtualTokens: number): number {
    if (!liquiditySol || !virtualTokens) return 0;
    return calculatePumpPrice(liquiditySol, virtualTokens);
}

function getRugMode(mode: BotMode): 'safe' | 'medium' | 'high' {
    if (mode === 'degen') return 'high';
    if (mode === 'sniper') return 'medium';
    // 'god', 'micro', 'custom' all use the strict rug gate
    return 'safe';
}

class PumpFunRunner {
    private readonly wallet = getConfiguredWallet();
    private readonly connection;
    private ws: WebSocket | null = null;
    private priceLoop: NodeJS.Timeout | null = null;
    private healthLoop: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private readonly tokenCache = new Map<string, TokenData>();
    private readonly trackedMints: string[] = [];
    private readonly subscribedMints = new Set<string>();
    private readonly analyzingMints = new Set<string>();
    private readonly processingMints = new Set<string>();
    private readonly analysisCooldowns = new Map<string, number>();
    // Tokens that have returned `wait` from the live entry guard. The
    // websocket only fires events on trades, so a quiet token in `wait` would
    // otherwise be dropped — we re-evaluate them on a periodic sweep instead.
    private readonly waitingMints = new Map<string, { token: TokenData; firstSeenAt: number; lastTriedAt: number }>();
    private rescanLoop: NodeJS.Timeout | null = null;
    private telemetryLoop: NodeJS.Timeout | null = null;
    private lastTradeTime = 0;
    private shuttingDown = false;
    private saveChain: Promise<void> = Promise.resolve();
    private lastRiskPauseLogAt = 0;
    private loggedCostGateWarning = false;

    constructor(private readonly config: RunnerConfig, private readonly state: BotState) {
        this.connection = createConnection(this.config.heliusKey);
    }

    async start(): Promise<void> {
        if (!this.config.dryRun && !this.wallet) {
            throw new Error('TRADER_PRIVATE_KEY is required when BOT_DRY_RUN=false');
        }
        if (!this.config.dryRun && !this.config.heliusKey) {
            throw new Error('HELIUS_API_KEY is required for live runner mode');
        }

        const balance = this.wallet ? await getBalance(this.wallet.publicKey.toBase58(), this.connection) : null;
        this.log(`Runner booting in ${this.config.dryRun ? 'dry-run' : 'live'} mode`);
        this.log(`Wallet: ${this.config.walletAddress || 'not configured'} | Balance: ${balance === null ? 'unavailable' : `${balance.toFixed(4)} SOL`}`);
        this.log(`Strategy: ${this.config.mode} | Trade amount: ${this.config.amountSol} SOL | Max trades: ${this.config.maxConcurrentTrades}`);
        this.log(`Risk rails: max ${this.config.maxConsecutiveLosses} consecutive losses, daily stop ${this.config.maxDailyLossSol.toFixed(4)} SOL, size band ${this.config.riskFloorMultiplier.toFixed(2)}x-${this.config.riskCeilingMultiplier.toFixed(2)}x`);

        // Reset session-cumulative rejection counters and start a fresh
        // session report. Without these resets the report would inherit
        // counters from the previous run when the runner restarts in-process.
        resetRejectionTelemetry();
        startSession({
            mode: this.config.mode,
            walletAddress: this.config.walletAddress,
            startingBalanceSol: balance,
            isDryRun: this.config.dryRun
        });

        await this.reconcileOpenPositions();
        this.startLoops();
        this.connectFeed();
    }

    async shutdown(reason: string): Promise<void> {
        this.shuttingDown = true;
        this.log(`Shutting down runner (${reason})`);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.priceLoop) clearInterval(this.priceLoop);
        if (this.healthLoop) clearInterval(this.healthLoop);
        if (this.rescanLoop) clearInterval(this.rescanLoop);
        if (this.telemetryLoop) clearInterval(this.telemetryLoop);
        if (this.ws) this.ws.close();
        await this.persistState();
        // Build + emit the end-of-session report. Catch all errors so a
        // report failure can never block clean shutdown (the operator's
        // bot-state.json is the authoritative record either way).
        try {
            const report = buildSessionReport({
                openPositions: this.state.openPositions,
                runnerMode: this.config.mode,
                isDryRun: this.config.dryRun
            });
            const formatted = formatSessionReport(report);
            for (const line of formatted.split('\n')) {
                this.log(line);
            }
            const reportPath = defaultSessionReportPath(path.dirname(this.config.statePath));
            await writeSessionReport(reportPath, report);
            this.log(`Session report written to ${reportPath}`);
        } catch (error: any) {
            this.log(`Failed to write session report: ${error.message || error}`);
        }
    }

    private startLoops(): void {
        this.priceLoop = setInterval(() => {
            void this.refreshOpenPositions();
        }, this.config.pricePollIntervalMs);

        this.healthLoop = setInterval(() => {
            const dailyRealized = this.getDailyRealizedPnl();
            const lossStreak = this.getLossStreak();
            this.log(`Health: ${this.state.openPositions.length} open position(s), realized ${this.state.totals.realizedProfitSol.toFixed(4)} SOL, daily ${dailyRealized.toFixed(4)} SOL, loss streak ${lossStreak}`);
        }, this.config.healthLogIntervalMs);

        // Rescan tokens that returned `wait` from the live guard. Without this
        // sweep, a token that ages 5s with not-yet-confirmed tape would be
        // dropped and never reconsidered, even if the tape develops cleanly
        // in the next 30s. This was a major contributor to the zero-trade
        // session — most launches need a few seconds to show a confirmable
        // pattern, and the websocket only fires events on individual trades.
        this.rescanLoop = setInterval(() => {
            void this.rescanWaitingTokens();
        }, 4000);

        // Periodic rejection telemetry summary so the operator sees which
        // gate is blocking entries instead of staring at silence.
        this.telemetryLoop = setInterval(() => {
            flushRejectionSummary((line) => this.log(line));
        }, 60_000);
    }

    private async rescanWaitingTokens(): Promise<void> {
        if (this.shuttingDown) return;
        if (this.state.openPositions.length >= this.config.maxConcurrentTrades) return;

        const now = Date.now();
        // Garbage-collect stale entries up front. A token older than 4 minutes
        // has missed its window across every mode and should be retired.
        for (const [mint, entry] of this.waitingMints.entries()) {
            const ageSeconds = (now - (entry.token.createdAt || entry.firstSeenAt)) / 1000;
            if (ageSeconds > 240 || (now - entry.firstSeenAt) > 4 * 60_000) {
                this.waitingMints.delete(mint);
            }
        }

        for (const [mint, entry] of this.waitingMints.entries()) {
            if (this.analyzingMints.has(mint) || this.processingMints.has(mint)) continue;
            if (this.state.openPositions.some((position) => position.mint === mint)) {
                this.waitingMints.delete(mint);
                continue;
            }
            // Throttle rescans per mint to ~1.5s so we don't burn RPC.
            if ((now - entry.lastTriedAt) < 1500) continue;
            entry.lastTriedAt = now;
            // Refresh the cached token (snapshot might have updated the merged form).
            const refreshed = this.tokenCache.get(mint) || entry.token;
            entry.token = refreshed;
            await this.maybeOpenPosition(refreshed);
        }
    }

    private connectFeed(): void {
        if (this.shuttingDown) return;
        this.log('Connecting to PumpPortal feed');

        const ws = new WebSocket('wss://pumpportal.fun/api/data');
        this.ws = ws;

        ws.on('open', () => {
            this.log('Feed connected');
            ws.send(JSON.stringify({ method: 'subscribeNewToken' }));

            const activeMints = new Set([
                ...this.trackedMints,
                ...this.state.openPositions.map((position) => position.mint)
            ]);

            for (const mint of activeMints) {
                this.subscribeToMint(mint);
            }
        });

        ws.on('message', (rawData) => {
            const payload = typeof rawData === 'string' ? rawData : rawData.toString();
            try {
                const parsed = JSON.parse(payload);
                if (parsed.mint) {
                    void this.processMarketEvent(normalizeTokenEvent(parsed, Date.now()));
                }
            } catch (error: any) {
                this.log(`Feed parse error: ${error.message}`);
            }
        });

        ws.on('close', () => {
            this.log('Feed disconnected');
            this.scheduleReconnect();
        });

        ws.on('error', (error) => {
            this.log(`Feed error: ${error.message}`);
        });
    }

    private scheduleReconnect(): void {
        if (this.shuttingDown || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.subscribedMints.clear();
            this.connectFeed();
        }, 3000);
    }

    private subscribeToMint(mint: string): void {
        if (!this.trackedMints.includes(mint)) {
            this.trackedMints.push(mint);
        }

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.subscribedMints.has(mint)) {
            return;
        }

        this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
        this.subscribedMints.add(mint);
        this.pruneTrackedMints();
    }

    private pruneTrackedMints(): void {
        while (this.trackedMints.length > this.config.maxTrackedMints) {
            const staleMint = this.trackedMints.find((mint) => !this.state.openPositions.some((position) => position.mint === mint));
            if (!staleMint) return;

            const index = this.trackedMints.indexOf(staleMint);
            this.trackedMints.splice(index, 1);

            if (this.ws && this.ws.readyState === WebSocket.OPEN && this.subscribedMints.has(staleMint)) {
                this.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [staleMint] }));
            }

            this.subscribedMints.delete(staleMint);
        }
    }

    private async processMarketEvent(token: TokenData): Promise<void> {
        const merged = mergeTokenData(this.tokenCache.get(token.mint), token);
        this.tokenCache.set(token.mint, merged);
        recordMarketEvent(merged);

        if (merged.txType === 'create') {
            this.subscribeToMint(merged.mint);
        }

        if (this.state.openPositions.some((position) => position.mint === merged.mint)) {
            await this.refreshPosition(merged.mint);
            return;
        }

        if (merged.txType === 'create' || (Date.now() - merged.timestamp) < 120_000) {
            await this.maybeOpenPosition(merged);
        }
    }

    private async maybeOpenPosition(token: TokenData): Promise<void> {
        if (this.state.openPositions.length >= this.config.maxConcurrentTrades) return;
        if (this.analyzingMints.has(token.mint) || this.processingMints.has(token.mint)) return;
        if (this.state.openPositions.some((position) => position.mint === token.mint)) return;
        if ((Date.now() - this.lastTradeTime) < this.config.minTimeBetweenTradesMs) return;
        // Cheap analysis cooldown — only used to throttle hard `reject` decisions.
        // `wait` decisions explicitly bypass this so the rescan loop can keep retrying.
        const cooldownEntry = this.analysisCooldowns.get(token.mint);
        if (cooldownEntry && (Date.now() - cooldownEntry) < this.config.analysisCooldownMs) return;

        const entryPauseReason = this.getEntryPauseReason();
        if (entryPauseReason) {
            recordEntryDecision({
                mode: this.config.mode,
                gate: 'risk-rail',
                status: 'reject',
                reason: entryPauseReason,
                mint: token.mint,
                symbol: token.symbol,
                log: (line) => this.log(line)
            });
            if ((Date.now() - this.lastRiskPauseLogAt) > 30_000) {
                this.log(`Entry paused: ${entryPauseReason}`);
                this.lastRiskPauseLogAt = Date.now();
            }
            return;
        }

        recordSeenToken();
        this.analyzingMints.add(token.mint);

        try {
            const rug = detectRug(token, getRugMode(this.config.mode));
            if (rug.isRug) {
                recordEntryDecision({
                    mode: this.config.mode,
                    gate: 'rug-detector',
                    status: 'reject',
                    reason: rug.reason,
                    mint: token.mint,
                    symbol: token.symbol,
                    log: (line) => this.log(line)
                });
                this.analysisCooldowns.set(token.mint, Date.now());
                this.waitingMints.delete(token.mint);
                return;
            }

            const analysis = await analyzeEnhanced(token, this.connection, this.config.heliusKey, this.config.mode, this.config.advanced);
            if (!analysis.passed) {
                const reason = analysis.reasons[0] || 'analysis rejected trade';
                // The analyzer is authoritative ONLY for hard security facts
                // (tier-0 fail, freeze/mint authority, honeypot, hard-blocked
                // launch types, creator exiting). Everything else — tape shape,
                // holder estimates, tier scores — is advisory; the flow entry
                // guard below is the single decision layer for tape quality.
                // Before this change, two independent gates each had to agree,
                // which is why the bot oscillated between never-trades and
                // whack-a-mole threshold tuning.
                const isTerminal = /tier 0|freeze|mint authority|metadata|hard ?block|honeypot|creator is exiting/i.test(reason);
                if (isTerminal) {
                    recordEntryDecision({
                        mode: this.config.mode,
                        gate: 'analyzer',
                        status: 'reject',
                        reason,
                        mint: token.mint,
                        symbol: token.symbol,
                        log: (line) => this.log(line)
                    });
                    this.analysisCooldowns.set(token.mint, Date.now());
                    this.waitingMints.delete(token.mint);
                    return;
                }
            }

            const amountSol = await this.getTradeSize(analysis);
            if (amountSol <= 0) {
                recordEntryDecision({
                    mode: this.config.mode,
                    gate: 'budget',
                    status: 'reject',
                    reason: 'amountSol <= 0 (budget or balance)',
                    mint: token.mint,
                    symbol: token.symbol,
                    log: (line) => this.log(line)
                });
                this.analysisCooldowns.set(token.mint, Date.now());
                return;
            }

            const entryDecision = evaluateLiveEntryGuard(this.config.mode, token, analysis, amountSol);
            if (entryDecision.status !== 'pass') {
                recordEntryDecision({
                    mode: this.config.mode,
                    gate: 'live-guard',
                    status: entryDecision.status,
                    reason: entryDecision.reason,
                    mint: token.mint,
                    symbol: token.symbol,
                    log: (line) => this.log(line)
                });
                if (entryDecision.status === 'wait') {
                    this.queueWait(token);
                } else {
                    this.analysisCooldowns.set(token.mint, Date.now());
                    this.waitingMints.delete(token.mint);
                }
                return;
            }

            const confirmationFailure = await this.confirmEntryWindow(token);
            if (confirmationFailure) {
                recordEntryDecision({
                    mode: this.config.mode,
                    gate: 'confirmation',
                    status: 'reject',
                    reason: confirmationFailure,
                    mint: token.mint,
                    symbol: token.symbol,
                    log: (line) => this.log(line)
                });
                this.analysisCooldowns.set(token.mint, Date.now());
                this.waitingMints.delete(token.mint);
                return;
            }

            recordEntryDecision({
                mode: this.config.mode,
                gate: 'live-guard',
                status: 'pass',
                mint: token.mint,
                symbol: token.symbol,
                log: (line) => this.log(line)
            });
            this.waitingMints.delete(token.mint);
            const exitStrategy = this.buildExitStrategy(token, analysis);
            await this.executeBuy(token, amountSol, exitStrategy, analysis.score, analysis.riskLevel, analysis.reasons);
        } catch (error: any) {
            this.log(`Analysis error for ${token.symbol}: ${error.message}`);
        } finally {
            this.analyzingMints.delete(token.mint);
        }
    }

    private queueWait(token: TokenData): void {
        const existing = this.waitingMints.get(token.mint);
        const now = Date.now();
        if (existing) {
            existing.token = token;
            existing.lastTriedAt = now;
        } else {
            this.waitingMints.set(token.mint, {
                token,
                firstSeenAt: now,
                lastTriedAt: now
            });
        }
    }

    private getUtcDayStart(now: number = Date.now()): number {
        const current = new Date(now);
        return Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
    }

    private getDailyRealizedPnl(now: number = Date.now()): number {
        const dayStart = this.getUtcDayStart(now);
        return this.state.closedPositions
            .filter((position) => (position.closeTime || 0) >= dayStart)
            .reduce((sum, position) => sum + (position.realizedProfitSol || 0), 0);
    }

    private getLossStreak(): number {
        let lossStreak = 0;
        for (const position of this.state.closedPositions) {
            if ((position.realizedProfitSol || 0) < 0) {
                lossStreak += 1;
            } else {
                break;
            }
        }
        return lossStreak;
    }

    private getRiskAdjustedSizeMultiplier(analysis: EnhancedAnalysis): number {
        let multiplier = 1;

        if (this.config.dynamicSizing) {
            if (analysis.score >= 90) multiplier *= 1.18;
            else if (analysis.score >= 80) multiplier *= 1.08;
            else if (analysis.score < 72) multiplier *= 0.82;
        }

        if (analysis.metrics.largestTraderVolumeShare > 0.24) multiplier *= 0.86;
        if (analysis.metrics.topTwoTraderVolumeShare > 0.46) multiplier *= 0.9;
        if (analysis.metrics.repeatTraderRatio > 0.35) multiplier *= 0.8;
        if (analysis.metrics.creatorVolumeShare > 0.16) multiplier *= 0.88;
        if (analysis.metrics.launchFlags.incentiveMode) multiplier *= 0.7;

        const cleanContinuation =
            analysis.metrics.buyPressure >= 0.72 &&
            analysis.metrics.uniqueTraderCount >= 8 &&
            analysis.metrics.repeatTraderRatio <= 0.28 &&
            analysis.metrics.topTwoTraderVolumeShare <= 0.42;
        if (cleanContinuation) {
            multiplier *= 1.08;
        }

        return Math.max(this.config.riskFloorMultiplier, Math.min(this.config.riskCeilingMultiplier, multiplier));
    }

    private async getTradeSize(analysis: EnhancedAnalysis): Promise<number> {
        if (analysis.metrics.launchFlags.hardBlock) {
            return 0;
        }

        let amount = this.config.amountSol * this.getRiskAdjustedSizeMultiplier(analysis);

        amount = Number(amount.toFixed(4));

        // Cost-coverage gate: a trade is only worth taking if the TP1 win
        // clearly beats the fixed cost stack (priority fees both legs plus
        // network fees). At the old preset sizes (0.002-0.008 SOL) fixed
        // costs exceeded the maximum possible win, which made every trade a
        // guaranteed loser regardless of entry quality.
        const buyPriorityFee = amount <= 0.05 ? 0.0003 : Math.max(0.001, Math.min(0.003, amount * 0.05));
        const sellPriorityFee = amount <= 0.05 ? 0.0003 : Math.max(0.0005, Math.min(0.002, amount * 0.02));
        const fixedCostSol = buyPriorityFee + sellPriorityFee + 0.00002;
        const tp1WinSol = amount * (this.config.defaultExit.takeProfit / 100);
        if (tp1WinSol < fixedCostSol * 2.5) {
            if (!this.loggedCostGateWarning) {
                this.loggedCostGateWarning = true;
                this.log(`Cost gate: trade size ${amount.toFixed(4)} SOL cannot clear the fee stack (TP1 win ${tp1WinSol.toFixed(5)} SOL vs ~${fixedCostSol.toFixed(5)} SOL fixed costs). Raise BOT_TRADE_AMOUNT_SOL to at least ${(fixedCostSol * 2.5 / (this.config.defaultExit.takeProfit / 100)).toFixed(3)} SOL.`);
            }
            return 0;
        }

        if (!this.wallet) {
            return amount;
        }

        const balance = await getBalance(this.wallet.publicKey.toBase58(), this.connection);
        if (balance === null) return 0;

        const maxSpendable = Math.max(0, balance - this.config.minBalanceReserveSol);
        if (maxSpendable <= 0) return 0;

        return Number(Math.min(amount, maxSpendable).toFixed(4));
    }

    private getEntryPauseReason(): string | null {
        if (this.config.dryRun) {
            return null;
        }

        const now = Date.now();
        const dailyRealizedPnl = this.getDailyRealizedPnl(now);
        if (dailyRealizedPnl <= -Math.abs(this.config.maxDailyLossSol)) {
            const nextResetMs = (this.getUtcDayStart(now) + 86_400_000) - now;
            return `daily loss rail active for ${Math.ceil(nextResetMs / 60000)}m (${dailyRealizedPnl.toFixed(4)} SOL <= -${this.config.maxDailyLossSol.toFixed(4)} SOL)`;
        }

        const isSelectiveMode =
            this.config.mode === 'god' ||
            this.config.mode === 'micro' ||
            this.config.mode === 'custom';
        const pauseWindowMs = isSelectiveMode ? 15 * 60 * 1000 : 8 * 60 * 1000;
        const recentClosed = this.state.closedPositions
            .filter((position) => position.txId && position.closeTime && (now - (position.closeTime || 0)) < pauseWindowMs)
            .slice(0, Math.max(3, this.config.maxConsecutiveLosses + 1));

        let lossStreak = 0;
        let cumulativeLoss = 0;
        for (const position of recentClosed) {
            if (position.realizedProfitSol < 0) {
                lossStreak += 1;
                cumulativeLoss += position.realizedProfitSol;
            } else {
                break;
            }
        }

        if (lossStreak === 0) {
            return null;
        }

        const thresholdLoss = isSelectiveMode
            ? Math.max(0.003, this.config.amountSol * 0.35)
            : Math.max(0.0035, this.config.amountSol * 0.5);
        const trippedBreaker = isSelectiveMode
            ? (lossStreak >= this.config.maxConsecutiveLosses || cumulativeLoss <= -thresholdLoss)
            : (lossStreak >= this.config.maxConsecutiveLosses || cumulativeLoss <= -thresholdLoss);
        if (!trippedBreaker) {
            return null;
        }

        const latestLossTime = recentClosed[0]?.closeTime || 0;
        const remainingMs = pauseWindowMs - (now - latestLossTime);
        if (remainingMs <= 0) {
            return null;
        }

        return `circuit breaker active for ${Math.ceil(remainingMs / 60000)}m after ${lossStreak} straight live losses (${cumulativeLoss.toFixed(4)} SOL)`;
    }

    private async confirmEntryWindow(token: TokenData): Promise<string | null> {
        const setupSnapshot = getMarketSnapshot(token.mint);
        const setupPumpData = await getPumpData(token.mint, this.connection);
        const setupLiquidity = setupPumpData?.vSolInBondingCurve || token.vSolInBondingCurve || 0;
        const setupVirtualTokens = setupPumpData?.vTokensInBondingCurve || token.vTokensInBondingCurve || 0;
        const setupCurve = setupPumpData?.bondingCurveProgress || 0;
        const setupPrice = calculatePrice(setupLiquidity, setupVirtualTokens);

        // Selective modes pause a touch longer to let the confirmation tape build.
        const isSlowConfirm = this.config.mode === 'god' || this.config.mode === 'micro' || this.config.mode === 'custom';
        await delay(isSlowConfirm ? 900 : 600);

        const freshPumpData = await getPumpData(token.mint, this.connection);
        const freshSnapshot = getMarketSnapshot(token.mint);
        const freshLiquidity = freshPumpData?.vSolInBondingCurve || setupLiquidity;
        const freshVirtualTokens = freshPumpData?.vTokensInBondingCurve || setupVirtualTokens;
        const freshCurve = freshPumpData?.bondingCurveProgress || setupCurve;
        const freshPrice = calculatePrice(freshLiquidity, freshVirtualTokens);
        const freshBuyPressure = freshSnapshot?.buyPressure ?? setupSnapshot?.buyPressure ?? 0;
        const freshNetFlow = freshSnapshot?.netFlowSol ?? setupSnapshot?.netFlowSol ?? 0;
        const tradeCount = freshSnapshot?.tradeCount ?? setupSnapshot?.tradeCount ?? 0;

        if (freshLiquidity <= 0 || freshVirtualTokens <= 0) {
            return 'verification snapshot was unavailable';
        }

        const isSelectiveMode =
            this.config.mode === 'god' ||
            this.config.mode === 'micro' ||
            this.config.mode === 'custom';
        const isProbeMode = this.config.mode === 'sniper';
        const isAggressiveMode = this.config.mode === 'degen';
        const liquidityDeltaPercent = setupLiquidity > 0 ? ((freshLiquidity - setupLiquidity) / setupLiquidity) * 100 : 0;
        const curveDelta = freshCurve - setupCurve;
        const priceDeltaPercent = setupPrice > 0 && freshPrice > 0 ? ((freshPrice - setupPrice) / setupPrice) * 100 : 0;
        // Significantly looser tolerances. The previous bars (-4% liquidity, -1.8%
        // price) were tighter than normal pump.fun volatility — even a single
        // sub-1-SOL sell during the 1s confirmation pause would flunk a 30 SOL
        // pool. Confirmation is meant to catch a clear fade between observation
        // and entry, not noise.
        // If tradeCount is 0, snapshot data is unavailable, so we skip the buy
        // pressure check and rely on liquidity/curve/price delta.
        const skipBuyPressureCheck = tradeCount === 0;
        const minBuyPressure = isSelectiveMode ? 0.5 : (isProbeMode ? 0.5 : (isAggressiveMode ? 0.5 : 0.48));
        const maxLiquidityDrop = isSelectiveMode ? -10 : (isProbeMode ? -12 : (isAggressiveMode ? -12 : -14));
        const maxCurveRollback = isSelectiveMode ? -2.5 : (isProbeMode ? -3 : (isAggressiveMode ? -3 : -3.5));
        const maxPriceFade = isSelectiveMode ? -5 : (isProbeMode ? -6 : (isAggressiveMode ? -6 : -8));

        if (
            liquidityDeltaPercent < maxLiquidityDrop ||
            curveDelta < maxCurveRollback ||
            priceDeltaPercent < maxPriceFade ||
            (!skipBuyPressureCheck && freshBuyPressure < minBuyPressure)
        ) {
            return `confirmation faded (${liquidityDeltaPercent.toFixed(1)}% liquidity, ${curveDelta.toFixed(1)} curve pts, ${priceDeltaPercent.toFixed(1)}% price, ${skipBuyPressureCheck ? 'N/A' : (freshBuyPressure * 100).toFixed(0) + '%'} buy pressure)`;
        }

        if (tradeCount >= 5 && freshNetFlow < -0.1) {
            return `flow turned negative during confirmation (${freshNetFlow.toFixed(2)} SOL)`;
        }

        return null;
    }

    private buildExitStrategy(token: TokenData, analysis: EnhancedAnalysis): ManagedExitStrategy {
        const snapshot = getMarketSnapshot(token.mint);
        const exit: ManagedExitStrategy = { ...this.config.defaultExit };
        const score = analysis.score;

        if (snapshot?.buyPressure && snapshot.buyPressure > 0.8) {
            exit.takeProfit += 5;
            if (exit.takeProfit2) {
                exit.takeProfit2 += 15;
            }
            if (exit.postTp1FloorPercent !== undefined) {
                exit.postTp1FloorPercent += 1;
            }
            if (exit.postTp2FloorPercent !== undefined) {
                exit.postTp2FloorPercent += 2;
            }
            if (exit.runnerTrailingStopPercent !== undefined) {
                exit.runnerTrailingStopPercent = Math.max(8, exit.runnerTrailingStopPercent - 2);
            }
        }

        if (score >= 90) {
            exit.maxHoldTime = Math.round(exit.maxHoldTime * 1.15);
            if (exit.takeProfit2) {
                exit.takeProfit2 += 20;
            }
            if (exit.runnerMaxHoldTime) {
                exit.runnerMaxHoldTime = Math.round(exit.runnerMaxHoldTime * 1.15);
            }
        }

        if (
            analysis.metrics.repeatTraderRatio > 0.32 ||
            analysis.metrics.creatorVolumeShare > 0.14 ||
            analysis.metrics.launchFlags.incentiveMode
        ) {
            exit.maxHoldTime = Math.max(18, Math.round(exit.maxHoldTime * 0.8));
            if (exit.runnerMaxHoldTime) {
                exit.runnerMaxHoldTime = Math.max(45, Math.round(exit.runnerMaxHoldTime * 0.7));
            }
            if (exit.runnerTrailingStopPercent !== undefined) {
                exit.runnerTrailingStopPercent = Math.max(5, exit.runnerTrailingStopPercent - 2);
            }
            if (exit.fastKillLoss !== undefined) {
                // Tighten fast-kill when token looks sketchy, but keep above the old
                // panic-level 2.4% floor that was getting us shaken out of normal wicks.
                exit.fastKillLoss = Math.min(exit.fastKillLoss, 3);
            }
        }

        if (this.config.mode === 'sniper') {
            exit.maxHoldTime = Math.min(exit.maxHoldTime, 45);
        }

        if (this.config.mode === 'degen') {
            exit.maxHoldTime = Math.min(exit.maxHoldTime, 70);
        }

        return exit;
    }

    private async confirmTokenBalance(mint: string, attempts: number = 3, delayMs: number = 1200): Promise<number> {
        if (!this.wallet) {
            return 0;
        }

        const walletAddress = this.wallet.publicKey.toBase58();
        let balance = 0;

        for (let attempt = 0; attempt < attempts; attempt++) {
            clearTokenBalanceCache(walletAddress, mint);
            balance = await getTokenBalance(walletAddress, mint, this.connection);
            if (balance > 0) {
                return balance;
            }

            if (attempt < attempts - 1) {
                await delay(delayMs);
            }
        }

        return balance;
    }

    private async executeBuy(
        token: TokenData,
        amountSol: number,
        exitStrategy: ManagedExitStrategy,
        analysisScore: number,
        analysisRisk: string,
        analysisReasons: string[]
    ): Promise<void> {
        if (amountSol <= 0) return;
        if (this.processingMints.has(token.mint)) return;

        this.processingMints.add(token.mint);

        // Record the attempt up front so the session report can show how
        // many candidates *tried* to buy vs. how many actually filled.
        recordBuyAttempt({
            mint: token.mint,
            symbol: token.symbol,
            mode: this.config.mode,
            amountSol,
            analysisScore,
            riskLevel: analysisRisk
        });

        try {
            const pumpData = await getPumpData(token.mint, this.connection);
            const entryPrice = pumpData ? calculatePrice(pumpData.vSolInBondingCurve, pumpData.vTokensInBondingCurve) : 0;
            if (entryPrice <= 0) {
                this.log(`Skipped ${token.symbol}: could not determine entry price`);
                recordBuyFailure({
                    mint: token.mint,
                    symbol: token.symbol,
                    mode: this.config.mode,
                    reason: 'no entry price'
                });
                return;
            }

            // Depth-aware buy slippage. Volatile tokens and thin pools need
            // more tolerance so legitimate fills don't get rejected. Keeps
            // paper and live in lockstep since both paths use this value.
            const buySnapshot = getMarketSnapshot(token.mint);
            const buySlippageDecision = computeDynamicBuySlippage({
                baseSlippagePercent: this.config.slippage,
                liquiditySol: pumpData?.vSolInBondingCurve || 0,
                amountSol,
                recentPriceChangePercent: buySnapshot?.maxPriceChangePercent,
                // velocitySolPerMin is a reasonable proxy for how fast the
                // curve is advancing right now.
                curveVelocityPercent: buySnapshot?.velocitySolPerMin
            });
            const buySlippagePercent = buySlippageDecision.slippagePercent;

            if (this.config.dryRun) {
                // Run the same fill simulation we use everywhere else (curve-
                // aware AMM math, 1% pump.fun fee, confirmation-window drift).
                // This replaces the old hardcoded `entryPrice * 1.015` which
                // massively understated real fill cost and was the root cause
                // of paper-vs-live P&L divergence.
                const buyExecution = estimatePaperBuyExecution({
                    observedPrice: entryPrice,
                    amountSol,
                    requestedSlippagePercent: buySlippagePercent,
                    exitStrategy,
                    curve: pumpData
                });

                if (!Number.isFinite(buyExecution.fillPrice) || buyExecution.fillPrice <= 0 || buyExecution.tokensOut <= 0) {
                    this.log(`[DRY RUN] Skipped ${token.symbol}: could not simulate fill`);
                    recordBuyFailure({
                        mint: token.mint,
                        symbol: token.symbol,
                        mode: this.config.mode,
                        reason: 'paper fill simulation produced invalid price'
                    });
                    return;
                }

                // Subtract rent + network fees the same way a live buy would,
                // so paper P&L reflects the full cost stack.
                const totalSolOut = amountSol + buyExecution.networkFeeSol + PAPER_TOKEN_ACCOUNT_RENT_SOL;

                const position: ManagedPosition = {
                    mint: token.mint,
                    symbol: token.symbol,
                    status: 'open',
                    buyPrice: buyExecution.fillPrice,
                    currentPrice: buyExecution.fillPrice,
                    highestPrice: buyExecution.fillPrice,
                    amountTokens: buyExecution.tokensOut,
                    amountSolPaid: totalSolOut,
                    buyTime: Date.now(),
                    partialSells: {},
                    realizedProfitSol: 0,
                    totalRevenueSol: 0,
                    analysisScore,
                    analysisRisk,
                    analysisReasons,
                    exitStrategy,
                    lastPriceUpdate: Date.now(),
                    lastLiquidity: pumpData?.vSolInBondingCurve
                };

                this.state.openPositions.unshift(position);
                this.lastTradeTime = Date.now();
                this.subscribeToMint(token.mint);
                this.log(`[DRY RUN] Bought ${token.symbol} for ${totalSolOut.toFixed(4)} SOL @ ${buyExecution.fillPrice.toExponential(3)} (score ${analysisScore})`);
                recordBuyFill({
                    mint: token.mint,
                    symbol: token.symbol,
                    mode: this.config.mode,
                    amountSol: totalSolOut,
                    fillPrice: buyExecution.fillPrice,
                    isDryRun: true
                });
                await this.persistState();
                return;
            }

            if (!this.wallet) {
                throw new Error('Live mode requires a configured wallet');
            }

            const balance = await getBalance(this.wallet.publicKey.toBase58(), this.connection);
            if (balance === null || balance < amountSol + this.config.minBalanceReserveSol) {
                this.log(`Skipped ${token.symbol}: insufficient balance for ${amountSol.toFixed(4)} SOL`);
                recordBuyFailure({
                    mint: token.mint,
                    symbol: token.symbol,
                    mode: this.config.mode,
                    reason: balance === null ? 'wallet balance unavailable' : `insufficient balance (${balance.toFixed(4)} SOL)`
                });
                return;
            }

            const priorityFee = amountSol <= 0.05 ? 0.0003 : Math.max(0.001, Math.min(0.003, amountSol * 0.05));
            let transactionBuffer: Uint8Array;

            try {
                transactionBuffer = await getTradeTransaction({
                    publicKey: this.wallet.publicKey.toBase58(),
                    action: 'buy',
                    mint: token.mint,
                    amount: amountSol,
                    denominatedInSol: 'true',
                    slippage: buySlippagePercent,
                    priorityFee,
                    pool: 'pump'
                });
            } catch {
                // Retry with a larger buffer on top of the dynamic value so
                // transient routing drift doesn't cost us the entry.
                transactionBuffer = await getTradeTransaction({
                    publicKey: this.wallet.publicKey.toBase58(),
                    action: 'buy',
                    mint: token.mint,
                    amount: amountSol,
                    denominatedInSol: 'true',
                    slippage: Math.max(buySlippagePercent + 10, 35),
                    priorityFee: 0.003,
                    pool: 'pump'
                });
            }

            const signature = await signAndSendTransaction(this.connection, transactionBuffer, this.wallet);
            const pendingPosition: ManagedPosition = {
                mint: token.mint,
                symbol: token.symbol,
                status: 'open',
                buyPrice: entryPrice,
                currentPrice: entryPrice,
                highestPrice: entryPrice,
                amountTokens: 0,
                amountSolPaid: amountSol,
                buyTime: Date.now(),
                txId: signature,
                partialSells: {},
                realizedProfitSol: 0,
                totalRevenueSol: 0,
                analysisScore,
                analysisRisk,
                analysisReasons,
                exitStrategy,
                lastPriceUpdate: Date.now(),
                lastLiquidity: pumpData?.vSolInBondingCurve
            };

            this.state.openPositions.unshift(pendingPosition);
            this.lastTradeTime = Date.now();
            this.subscribeToMint(token.mint);
            this.log(`Buy sent for ${token.symbol}: ${signature.slice(0, 8)}...`);
            await this.persistState();

            const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
            if (confirmation.value.err) {
                recordBuyFailure({
                    mint: token.mint,
                    symbol: token.symbol,
                    mode: this.config.mode,
                    reason: `chain rejected buy tx ${signature.slice(0, 8)}`
                });
                this.state.openPositions = this.state.openPositions.filter((position) => position.txId !== signature);
                await this.persistState();
                throw new Error('buy transaction failed on chain');
            }

            await delay(2000);
            const actualTokens = await this.confirmTokenBalance(token.mint, 4, 1200);
            this.state.openPositions = this.state.openPositions.map((position) => {
                if (position.txId !== signature) return position;
                return {
                    ...position,
                    amountTokens: actualTokens,
                    buyPrice: actualTokens > 0 ? amountSol / actualTokens : position.buyPrice,
                    currentPrice: actualTokens > 0 ? amountSol / actualTokens : position.currentPrice,
                    highestPrice: actualTokens > 0 ? amountSol / actualTokens : position.highestPrice
                };
            });

            if (actualTokens > 0) {
                this.log(`Buy confirmed for ${token.symbol}: ${actualTokens.toFixed(4)} tokens`);
            } else {
                this.log(`Buy confirmed for ${token.symbol}, but wallet token balance is still settling. Runner will keep reconciling the position.`);
            }
            // Live fill recorded after on-chain confirmation. We use the
            // entry price as fill-price proxy because the actual filled
            // amount can still be settling — it'll be reconciled later in
            // refreshPosition once the wallet balance is visible.
            recordBuyFill({
                mint: token.mint,
                symbol: token.symbol,
                mode: this.config.mode,
                amountSol,
                fillPrice: actualTokens > 0 ? amountSol / actualTokens : entryPrice,
                isDryRun: false,
                txId: signature
            });
            await this.persistState();
        } catch (error: any) {
            // Anything that throws (rpc errors, signature failure, etc.)
            // counts as a failure for the report. The chain-reject path
            // above also throws, but it has already logged its own
            // failure entry; recordBuyFailure is idempotent on the set
            // of (mint,reason) so a duplicate is fine.
            if (!String(error?.message || '').includes('chain rejected buy tx')) {
                recordBuyFailure({
                    mint: token.mint,
                    symbol: token.symbol,
                    mode: this.config.mode,
                    reason: error?.message || 'unknown buy error'
                });
            }
            throw error;
        } finally {
            this.processingMints.delete(token.mint);
        }
    }

    private async refreshOpenPositions(): Promise<void> {
        for (const position of [...this.state.openPositions]) {
            await this.refreshPosition(position.mint);
        }
    }

    private async refreshPosition(mint: string): Promise<void> {
        const position = this.state.openPositions.find((item) => item.mint === mint);
        if (!position || this.processingMints.has(mint)) return;

        try {
            if (!this.config.dryRun && this.wallet && position.amountTokens <= 0) {
                const walletBalance = await this.confirmTokenBalance(mint, 3, 1000);
                if (walletBalance > 0) {
                    position.amountTokens = walletBalance;
                    if (position.amountSolPaid > 0) {
                        position.buyPrice = position.amountSolPaid / walletBalance;
                        position.currentPrice = position.buyPrice;
                        position.highestPrice = Math.max(position.highestPrice, position.buyPrice);
                    }
                }
            }

            // Creator-sell instant exit. In captured live data, 36 of 42
            // launches ended as creator-exits, and the first creator sell was
            // the earliest reliable signal. Entries require zero creator
            // sells, so any positive count while holding means the rug just
            // started — get out before the crowd does.
            const liveSnapshot = getMarketSnapshot(mint);
            if (liveSnapshot && liveSnapshot.creatorSellCount > 0) {
                await this.executeSell(mint, 100, `creator sold (${liveSnapshot.creatorSellCount} sell${liveSnapshot.creatorSellCount === 1 ? '' : 's'})`);
                return;
            }

            const pumpData = await getPumpData(mint, this.connection);
            if (!pumpData) return;

            const currentPrice = calculatePrice(pumpData.vSolInBondingCurve, pumpData.vTokensInBondingCurve);
            if (currentPrice <= 0) return;

            const nextPosition: ManagedPosition = {
                ...position,
                currentPrice,
                highestPrice: Math.max(position.highestPrice || 0, currentPrice),
                lastPriceUpdate: Date.now(),
                lastLiquidity: pumpData.vSolInBondingCurve
            };
            const strategy = nextPosition.exitStrategy;
            const runnerActive = hasTp1Sell(nextPosition.partialSells);
            const isFastTrade = !!strategy.maxHoldTime && strategy.maxHoldTime <= 90;

            this.replaceOpenPosition(nextPosition);

            if (position.lastLiquidity && position.lastLiquidity > 5) {
                const liquidityDrop = (position.lastLiquidity - pumpData.vSolInBondingCurve) / position.lastLiquidity;
                // Pump.fun tokens regularly see 10-20% transient liquidity dips during
                // normal trading. Only treat drops above 25-35% as rug signals so we
                // stop panic-selling through healthy volatility.
                const rugDropThreshold = isFastTrade ? 0.25 : 0.35;
                if (liquidityDrop > rugDropThreshold) {
                    await this.executeSell(mint, 100, `liquidity drop >${Math.round(rugDropThreshold * 100)}%`);
                    return;
                }
            }

            if (nextPosition.buyPrice <= 0 || nextPosition.amountTokens <= 0) {
                await this.persistState();
                return;
            }

            const pnl = ((nextPosition.currentPrice - nextPosition.buyPrice) / nextPosition.buyPrice) * 100;
            const holdTime = (Date.now() - nextPosition.buyTime) / 1000;
            const peakGain = nextPosition.highestPrice > nextPosition.buyPrice
                ? ((nextPosition.highestPrice - nextPosition.buyPrice) / nextPosition.buyPrice) * 100
                : 0;
            const dropFromPeak = nextPosition.highestPrice > 0
                ? ((nextPosition.highestPrice - nextPosition.currentPrice) / nextPosition.highestPrice) * 100
                : 0;
            const fastKillSeconds = strategy.fastKillSeconds ?? 6;
            const fastKillLoss = Math.abs(strategy.fastKillLoss ?? 4);
            const givebackSeconds = strategy.givebackSeconds ?? 10;
            const givebackPeakTrigger = strategy.givebackPeakTrigger ?? 4;
            const givebackFloor = strategy.givebackFloor ?? 0;
            const stagnationSeconds = strategy.stagnationSeconds ?? 0;
            const stagnationFloor = strategy.stagnationFloor ?? 0;
            const profitLockFloor = getProfitLockFloor(strategy, nextPosition.partialSells);
            const runnerTrailingStopPercent = getRunnerTrailingStopPercent(strategy, nextPosition.partialSells);
            const runnerMaxHoldTime = getRunnerMaxHoldTime(strategy, nextPosition.partialSells);

            if (isFastTrade && !runnerActive && holdTime >= fastKillSeconds && pnl <= -fastKillLoss) {
                await this.executeSell(mint, 100, `fast kill ${pnl.toFixed(2)}%`);
                return;
            }

            if (isFastTrade && !runnerActive && holdTime >= givebackSeconds && peakGain >= givebackPeakTrigger && pnl <= givebackFloor) {
                await this.executeSell(mint, 100, `fast giveback from ${peakGain.toFixed(2)}%`);
                return;
            }

            if (isFastTrade && !runnerActive && stagnationSeconds > 0 && holdTime >= stagnationSeconds && peakGain < givebackPeakTrigger && pnl <= stagnationFloor) {
                await this.executeSell(mint, 100, `fast stall ${pnl.toFixed(2)}% after ${holdTime.toFixed(0)}s`);
                return;
            }

            if (profitLockFloor !== null && pnl <= profitLockFloor) {
                await this.executeSell(mint, 100, `profit lock ${pnl.toFixed(2)}%`);
                return;
            }

            if (runnerTrailingStopPercent !== null && peakGain >= getRunnerActivationProfit(strategy) && dropFromPeak >= runnerTrailingStopPercent) {
                await this.executeSell(mint, 100, `runner trail ${dropFromPeak.toFixed(2)}%`);
                return;
            }

            if (pnl <= -Math.abs(strategy.stopLoss)) {
                await this.executeSell(mint, 100, `stop loss ${pnl.toFixed(2)}%`);
                return;
            }

            if (runnerMaxHoldTime && holdTime >= runnerMaxHoldTime) {
                const runnerTimeExitFloor = getRunnerTimeExitFloor(strategy);
                if (pnl < runnerTimeExitFloor) {
                    await this.executeSell(mint, 100, `runner time exit ${pnl.toFixed(2)}%`);
                    return;
                }
            } else if (!runnerActive && holdTime >= strategy.maxHoldTime) {
                await this.executeSell(mint, 100, `time limit ${strategy.maxHoldTime}s`);
                return;
            }

            const hasStagedExit = !!strategy.takeProfit2 || runnerTrailingStopPercent !== null || profitLockFloor !== null;
            if (pnl >= strategy.takeProfit && !nextPosition.partialSells.tp1) {
                const percent = hasStagedExit ? getTp1SellPercent(strategy) : 100;
                await this.executeSell(mint, percent, `take profit ${pnl.toFixed(2)}%`, hasStagedExit ? 'tp1' : undefined);
                return;
            }

            if (strategy.takeProfit2 && pnl >= strategy.takeProfit2 && !nextPosition.partialSells.tp2) {
                await this.executeSell(mint, getTp2SellPercent(strategy), `take profit 2 ${pnl.toFixed(2)}%`, 'tp2');
                return;
            }

            // Profit-protection bands used to fire on peakGain>=20 with pnl<=10 and
            // peakGain>=10 with pnl<=5 — that cut winners off before they had room
            // to consolidate and continue. Widen the gates so we only lock profit
            // once the token has made a real move and we've given back a clear chunk.
            if (!runnerActive && peakGain >= 30 && pnl > 0 && pnl <= 8) {
                await this.executeSell(mint, 100, `profit protection ${pnl.toFixed(2)}%`);
                return;
            }

            if (!runnerActive && peakGain >= 18 && pnl > 0 && pnl <= 3) {
                await this.executeSell(mint, 100, `profit protection ${pnl.toFixed(2)}%`);
                return;
            }

            if (!runnerActive && peakGain >= 12) {
                // Widened adaptive trailing bands — old values (8-15%) exited on normal
                // pump.fun retracements. New bands let winners breathe while still
                // locking in a clear downswing.
                let adaptiveTrailPercent = 20;
                if (peakGain >= 50) adaptiveTrailPercent = 12;
                else if (peakGain >= 30) adaptiveTrailPercent = 15;
                else if (peakGain >= 18) adaptiveTrailPercent = 17;

                if (dropFromPeak >= adaptiveTrailPercent) {
                    await this.executeSell(mint, 100, `adaptive trail ${dropFromPeak.toFixed(2)}%`);
                    return;
                }
            }

            if (strategy.trailingStop && peakGain >= 10) {
                const trailingStopPercent = strategy.trailingStopPercent || 10;
                if (dropFromPeak >= trailingStopPercent) {
                    await this.executeSell(mint, 100, `trailing stop ${dropFromPeak.toFixed(2)}%`);
                    return;
                }
            }

            await this.persistState();
        } catch (error: any) {
            this.log(`Price refresh failed for ${position.symbol}: ${error.message}`);
        }
    }

    private async executeSell(mint: string, amountPercent: number, reason: string, stage?: 'tp1' | 'tp2'): Promise<void> {
        const position = this.state.openPositions.find((item) => item.mint === mint);
        if (!position || this.processingMints.has(mint)) return;

        this.processingMints.add(mint);
        const normalizedPercent = clampPercent(amountPercent);

        try {
            if (this.config.dryRun) {
                await this.applyDryRunSell(position, normalizedPercent, reason, stage);
                return;
            }

            if (!this.wallet) {
                throw new Error('Live mode requires a configured wallet');
            }

            const tokenBalance = await this.confirmTokenBalance(mint, 3, 1000);
            if (tokenBalance <= 0) {
                this.log(`Sell skipped for ${position.symbol}: wallet token balance could not be verified after repeated checks. Leaving position open.`);
                return;
            }

            const sellFraction = normalizedPercent / 100;
            const amountToSell = tokenBalance * sellFraction;
            const priorityFee = position.amountSolPaid <= 0.05 ? 0.0003 : Math.max(0.0005, Math.min(0.002, position.amountSolPaid * 0.02));

            this.replaceOpenPosition({ ...position, status: 'selling' });
            await this.persistState();

            // Depth-aware sell slippage. Rugs, stop-losses and other panic
            // exits get extra tolerance so we actually land the sell;
            // orphaned positions are the worst outcome. Controlled profit-
            // takes stay near the preset minimum.
            const currentPump = await getPumpData(mint, this.connection).catch(() => null);
            const currentLiquidity = currentPump?.vSolInBondingCurve ?? position.lastLiquidity;
            const holdDurationSeconds = (Date.now() - position.buyTime) / 1000;
            const sellSlippageDecision = computeDynamicSellSlippage({
                baseSlippagePercent: this.config.slippage,
                closeReason: reason,
                initialLiquiditySol: position.lastLiquidity,
                currentLiquiditySol: currentLiquidity,
                holdDurationSeconds
            });
            const sellSlippagePercent = sellSlippageDecision.slippagePercent;

            let transactionBuffer: Uint8Array;
            try {
                transactionBuffer = await getTradeTransaction({
                    publicKey: this.wallet.publicKey.toBase58(),
                    action: 'sell',
                    mint,
                    amount: amountToSell,
                    denominatedInSol: 'false',
                    slippage: sellSlippagePercent,
                    priorityFee,
                    pool: 'auto'
                });
            } catch {
                transactionBuffer = await getTradeTransaction({
                    publicKey: this.wallet.publicKey.toBase58(),
                    action: 'sell',
                    mint,
                    amount: amountToSell,
                    denominatedInSol: 'false',
                    slippage: Math.max(sellSlippagePercent + 15, 60),
                    priorityFee: 0.003,
                    pool: 'auto'
                });
            }

            const balanceBefore = await getBalance(this.wallet.publicKey.toBase58(), this.connection);
            const signature = await signAndSendTransaction(this.connection, transactionBuffer, this.wallet);
            const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
            if (confirmation.value.err) {
                throw new Error('sell transaction failed on chain');
            }

            await delay(2000);
            clearTokenBalanceCache(this.wallet.publicKey.toBase58(), mint);
            const actualRemaining = await getTokenBalance(this.wallet.publicKey.toBase58(), mint, this.connection);
            // Full exit: reclaim the token-account rent (~0.00204 SOL) before
            // measuring revenue so the refund is counted in realized P&L.
            if (normalizedPercent >= 100 && actualRemaining <= 0.000001) {
                const closed = await closeEmptyTokenAccounts(this.wallet, mint, this.connection);
                if (closed > 0) {
                    this.log(`Recovered rent from ${closed} token account(s) for ${position.symbol}`);
                }
            }
            const balanceAfter = await getBalance(this.wallet.publicKey.toBase58(), this.connection);
            const revenue = (balanceAfter ?? 0) - (balanceBefore ?? 0);
            const costBasis = position.amountSolPaid * sellFraction;
            const realizedProfit = revenue - costBasis;

            this.state.totals.realizedProfitSol += realizedProfit;

            const remainingFraction = Math.max(0, 1 - sellFraction);
            const updatedPosition: ManagedPosition = {
                ...position,
                status: actualRemaining > 0.000001 && remainingFraction > 0.000001 ? 'open' : 'closed',
                amountTokens: actualRemaining,
                amountSolPaid: position.amountSolPaid * remainingFraction,
                realizedProfitSol: position.realizedProfitSol + realizedProfit,
                totalRevenueSol: position.totalRevenueSol + revenue,
                partialSells: {
                    ...position.partialSells,
                    ...(stage ? { [stage]: true } : {})
                },
                closeReason: reason,
                closeTime: actualRemaining > 0.000001 && remainingFraction > 0.000001 ? undefined : Date.now()
            };

            if (updatedPosition.status === 'closed') {
                this.finalizeClosedPosition(updatedPosition, reason);
            } else {
                this.replaceOpenPosition(updatedPosition);
            }

            this.log(`Sold ${normalizedPercent}% of ${position.symbol}: ${realizedProfit >= 0 ? '+' : ''}${realizedProfit.toFixed(4)} SOL (${reason})`);
            await this.persistState();
        } catch (error: any) {
            this.log(`Sell failed for ${position.symbol}: ${error.message}`);
            this.replaceOpenPosition({ ...position, status: 'open' });
            await this.persistState();
        } finally {
            this.processingMints.delete(mint);
        }
    }

    private async applyDryRunSell(position: ManagedPosition, amountPercent: number, reason: string, stage?: 'tp1' | 'tp2'): Promise<void> {
        const sellFraction = amountPercent / 100;
        const soldTokenAmount = position.amountTokens * sellFraction;

        // Fetch fresh curve state so the sell simulation uses the real AMM
        // reserves, not a stale cached price. This is the sell side of the fix
        // that used to compute `position.currentPrice * 0.97` — a flat 3%
        // slippage that was wildly optimistic on thin pools.
        let curve: { vSolInBondingCurve?: number; vTokensInBondingCurve?: number } | null = null;
        try {
            curve = await getPumpData(position.mint, this.connection);
        } catch {
            curve = null;
        }

        const failureSeed = `${position.mint}:${position.buyTime}:${stage ?? 'full'}`;
        const sellExecution = estimatePaperSellExecution({
            observedPrice: position.currentPrice,
            amountSolPaid: position.amountSolPaid * sellFraction,
            amountTokens: soldTokenAmount,
            exitStrategy: position.exitStrategy,
            curve,
            failureSeed
        });

        const remainingFraction = Math.max(0, 1 - sellFraction);
        // Full close recovers the token-account rent, mirroring the live
        // path's closeEmptyTokenAccounts call.
        const rentRefund = remainingFraction <= 0.000001 ? PAPER_TOKEN_ACCOUNT_RENT_SOL : 0;
        const revenue = sellExecution.netProceedsSol + rentRefund;
        const costBasis = position.amountSolPaid * sellFraction;
        const realizedProfit = revenue - costBasis;

        this.state.totals.realizedProfitSol += realizedProfit;

        const updatedPosition: ManagedPosition = {
            ...position,
            status: remainingFraction > 0.000001 ? 'open' : 'closed',
            amountTokens: position.amountTokens * remainingFraction,
            amountSolPaid: position.amountSolPaid * remainingFraction,
            realizedProfitSol: position.realizedProfitSol + realizedProfit,
            totalRevenueSol: position.totalRevenueSol + revenue,
            partialSells: {
                ...position.partialSells,
                ...(stage ? { [stage]: true } : {})
            },
            closeReason: reason,
            closeTime: remainingFraction > 0.000001 ? undefined : Date.now()
        };

        if (updatedPosition.status === 'closed') {
            this.finalizeClosedPosition(updatedPosition, reason);
        } else {
            this.replaceOpenPosition(updatedPosition);
        }

        const retryTag = sellExecution.retried ? ' [retry]' : '';
        this.log(`[DRY RUN] Sold ${amountPercent}% of ${position.symbol}${retryTag}: ${realizedProfit >= 0 ? '+' : ''}${realizedProfit.toFixed(4)} SOL (${reason})`);
        await this.persistState();
    }

    private async forceCloseWorthlessPosition(position: ManagedPosition, reason: string): Promise<void> {
        const loss = -position.amountSolPaid;
        const closedPosition: ManagedPosition = {
            ...position,
            status: 'closed',
            amountTokens: 0,
            currentPrice: 0,
            realizedProfitSol: position.realizedProfitSol + loss,
            closeReason: reason,
            closeTime: Date.now()
        };

        this.state.totals.realizedProfitSol += loss;
        this.finalizeClosedPosition(closedPosition, reason);
        this.log(`Marked ${position.symbol} as worthless: ${loss.toFixed(4)} SOL (${reason})`);
        await this.persistState();
    }

    private finalizeClosedPosition(position: ManagedPosition, reason: string): void {
        const closedPosition: ManagedPosition = {
            ...position,
            status: 'closed',
            closeReason: reason,
            closeTime: position.closeTime || Date.now()
        };
        this.state.openPositions = this.state.openPositions.filter((item) => item.mint !== position.mint);
        this.state.closedPositions.unshift(closedPosition);
        this.state.closedPositions = this.state.closedPositions.slice(0, 200);
        this.state.totals.trades += 1;
        if (position.realizedProfitSol > 0) {
            this.state.totals.wins += 1;
        } else {
            this.state.totals.losses += 1;
        }
        // Hand the closed position to the session report so the end-of-run
        // summary can compute win-rate, hold time, top close reasons, etc.
        recordPositionClose({
            position: closedPosition,
            mode: this.config.mode,
            closeReason: reason,
            isDryRun: this.config.dryRun
        });
        clearMarketSnapshot(position.mint);
    }

    private replaceOpenPosition(nextPosition: ManagedPosition): void {
        this.state.openPositions = this.state.openPositions.map((position) =>
            position.mint === nextPosition.mint ? nextPosition : position
        );
    }

    private async reconcileOpenPositions(): Promise<void> {
        if (this.config.dryRun || !this.wallet) {
            return;
        }

        for (const position of [...this.state.openPositions]) {
            const balance = await this.confirmTokenBalance(position.mint, 3, 1000);
            if (balance <= 0) {
                this.log(`Startup reconciliation could not verify ${position.symbol} token balance after repeated checks. Keeping the position open for later sync.`);
                this.subscribeToMint(position.mint);
                continue;
            }

            position.amountTokens = balance;
            if (position.amountSolPaid > 0) {
                position.buyPrice = position.amountSolPaid / balance;
            }
            this.subscribeToMint(position.mint);
        }

        await this.persistState();
    }

    private persistState(): Promise<void> {
        this.state.updatedAt = Date.now();
        this.saveChain = this.saveChain.then(() => saveState(this.config.statePath, this.state)).catch(() => undefined);
        return this.saveChain;
    }

    private log(message: string): void {
        const entry = `[${new Date().toISOString()}] ${message}`;
        console.log(entry);
        this.state.logs.unshift(entry);
        this.state.logs = this.state.logs.slice(0, 200);
    }
}

async function main() {
    const config = loadRunnerConfig();
    const state = await loadState(config.statePath, config.walletAddress);
    const runner = new PumpFunRunner(config, state);

    const shutdown = async (signal: string) => {
        await runner.shutdown(signal);
        process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await runner.start();
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
