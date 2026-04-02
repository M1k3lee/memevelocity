import WebSocket from 'ws';
import { clearTokenBalanceCache, createConnection, getBalance, getPumpData, getTokenBalance } from '../utils/solanaManager';
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
    getProfitLockFloor,
    getRunnerActivationProfit,
    getRunnerMaxHoldTime,
    getRunnerTimeExitFloor,
    getRunnerTrailingStopPercent,
    getTp1SellPercent,
    getTp2SellPercent,
    hasTp1Sell
} from '../utils/tradeExit';

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
    if (mode === 'degen' || mode === 'velocity' || mode === 'high' || mode === 'scalp') return 'high';
    if (mode === 'sniper' || mode === 'first') return 'medium';
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
    private lastTradeTime = 0;
    private shuttingDown = false;
    private saveChain: Promise<void> = Promise.resolve();
    private lastRiskPauseLogAt = 0;

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
        if (this.ws) this.ws.close();
        await this.persistState();
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
        if (this.analysisCooldowns.has(token.mint) && (Date.now() - (this.analysisCooldowns.get(token.mint) || 0)) < this.config.analysisCooldownMs) return;
        if (this.analyzingMints.has(token.mint) || this.processingMints.has(token.mint)) return;
        if (this.state.openPositions.some((position) => position.mint === token.mint)) return;
        if ((Date.now() - this.lastTradeTime) < this.config.minTimeBetweenTradesMs) return;

        const entryPauseReason = this.getEntryPauseReason();
        if (entryPauseReason) {
            if ((Date.now() - this.lastRiskPauseLogAt) > 30_000) {
                this.log(`Entry paused: ${entryPauseReason}`);
                this.lastRiskPauseLogAt = Date.now();
            }
            return;
        }

        this.analysisCooldowns.set(token.mint, Date.now());
        this.analyzingMints.add(token.mint);

        try {
            const rug = detectRug(token, getRugMode(this.config.mode));
            if (rug.isRug) {
                if (token.txType === 'create') {
                    this.log(`Rejected ${token.symbol}: ${rug.reason}`);
                }
                return;
            }

            const analysis = await analyzeEnhanced(token, this.connection, this.config.heliusKey, this.config.mode, this.config.advanced);
            if (!analysis.passed) {
                if (token.txType === 'create') {
                    this.log(`Filtered ${token.symbol}: ${analysis.reasons[0] || 'analysis rejected trade'}`);
                }
                return;
            }

            const amountSol = await this.getTradeSize(analysis);
            if (amountSol <= 0) return;

            const entryDecision = evaluateLiveEntryGuard(this.config.mode, token, analysis, amountSol);
            if (entryDecision.status !== 'pass') {
                if (token.txType === 'create') {
                    const decisionLabel = entryDecision.status === 'wait' ? 'Waiting on' : 'Skipped';
                    this.log(`${decisionLabel} ${token.symbol}: ${entryDecision.reason || 'entry confirmation not met'}`);
                }
                return;
            }

            const confirmationFailure = await this.confirmEntryWindow(token);
            if (confirmationFailure) {
                if (token.txType === 'create') {
                    this.log(`Skipped ${token.symbol}: ${confirmationFailure}`);
                }
                return;
            }

            const exitStrategy = this.buildExitStrategy(token, analysis);
            await this.executeBuy(token, amountSol, exitStrategy, analysis.score, analysis.riskLevel, analysis.reasons);
        } catch (error: any) {
            this.log(`Analysis error for ${token.symbol}: ${error.message}`);
        } finally {
            this.analyzingMints.delete(token.mint);
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
            this.config.mode === 'runner' ||
            this.config.mode === 'safe' ||
            this.config.mode === 'medium';
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

        await delay(this.config.mode === 'god' || this.config.mode === 'runner' ? 1200 : 800);

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
            this.config.mode === 'runner' ||
            this.config.mode === 'safe' ||
            this.config.mode === 'medium';
        const isProbeMode =
            this.config.mode === 'sniper' ||
            this.config.mode === 'first';
        const isAggressiveMode =
            this.config.mode === 'degen' ||
            this.config.mode === 'velocity' ||
            this.config.mode === 'high' ||
            this.config.mode === 'scalp';
        const liquidityDeltaPercent = setupLiquidity > 0 ? ((freshLiquidity - setupLiquidity) / setupLiquidity) * 100 : 0;
        const curveDelta = freshCurve - setupCurve;
        const priceDeltaPercent = setupPrice > 0 && freshPrice > 0 ? ((freshPrice - setupPrice) / setupPrice) * 100 : 0;
        const minBuyPressure = isSelectiveMode ? 0.57 : (isProbeMode ? 0.56 : (isAggressiveMode ? 0.55 : 0.52));
        const maxLiquidityDrop = isSelectiveMode ? -4 : (isProbeMode ? -3.8 : (isAggressiveMode ? -4.5 : -6));
        const maxCurveRollback = isSelectiveMode ? -0.8 : (isProbeMode ? -0.7 : (isAggressiveMode ? -0.9 : -1.2));
        const maxPriceFade = isSelectiveMode ? -1.8 : (isProbeMode ? -1.4 : (isAggressiveMode ? -2.0 : -2.5));

        if (
            liquidityDeltaPercent < maxLiquidityDrop ||
            curveDelta < maxCurveRollback ||
            priceDeltaPercent < maxPriceFade ||
            freshBuyPressure < minBuyPressure
        ) {
            return `confirmation faded (${liquidityDeltaPercent.toFixed(1)}% liquidity, ${curveDelta.toFixed(1)} curve pts, ${priceDeltaPercent.toFixed(1)}% price, ${(freshBuyPressure * 100).toFixed(0)}% buy pressure)`;
        }

        if (tradeCount >= 3 && freshNetFlow < 0) {
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
                exit.fastKillLoss = Math.min(exit.fastKillLoss, 2.4);
            }
        }

        if (this.config.mode === 'sniper' || this.config.mode === 'first') {
            exit.maxHoldTime = Math.min(exit.maxHoldTime, 45);
        }

        if (this.config.mode === 'degen' || this.config.mode === 'velocity' || this.config.mode === 'high' || this.config.mode === 'scalp') {
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

        try {
            const pumpData = await getPumpData(token.mint, this.connection);
            const entryPrice = pumpData ? calculatePrice(pumpData.vSolInBondingCurve, pumpData.vTokensInBondingCurve) : 0;
            if (entryPrice <= 0) {
                this.log(`Skipped ${token.symbol}: could not determine entry price`);
                return;
            }

            if (this.config.dryRun) {
                const effectiveBuyPrice = entryPrice * 1.015;
                const tradeableSol = Math.max(0, (amountSol * 0.99) - 0.00204);
                const amountTokens = tradeableSol > 0 ? tradeableSol / effectiveBuyPrice : 0;

                const position: ManagedPosition = {
                    mint: token.mint,
                    symbol: token.symbol,
                    status: 'open',
                    buyPrice: effectiveBuyPrice,
                    currentPrice: effectiveBuyPrice,
                    highestPrice: effectiveBuyPrice,
                    amountTokens,
                    amountSolPaid: amountSol,
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
                this.log(`[DRY RUN] Bought ${token.symbol} for ${amountSol.toFixed(4)} SOL (score ${analysisScore})`);
                await this.persistState();
                return;
            }

            if (!this.wallet) {
                throw new Error('Live mode requires a configured wallet');
            }

            const balance = await getBalance(this.wallet.publicKey.toBase58(), this.connection);
            if (balance === null || balance < amountSol + this.config.minBalanceReserveSol) {
                this.log(`Skipped ${token.symbol}: insufficient balance for ${amountSol.toFixed(4)} SOL`);
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
                    slippage: this.config.slippage,
                    priorityFee,
                    pool: 'pump'
                });
            } catch {
                transactionBuffer = await getTradeTransaction({
                    publicKey: this.wallet.publicKey.toBase58(),
                    action: 'buy',
                    mint: token.mint,
                    amount: amountSol,
                    denominatedInSol: 'true',
                    slippage: Math.max(this.config.slippage, 35),
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
            await this.persistState();
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
                const rugDropThreshold = isFastTrade ? 0.1 : 0.2;
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

            if (!runnerActive && peakGain >= 20 && pnl > 0 && pnl <= 10) {
                await this.executeSell(mint, 100, `profit protection ${pnl.toFixed(2)}%`);
                return;
            }

            if (!runnerActive && peakGain >= 10 && pnl > 0 && pnl <= 5) {
                await this.executeSell(mint, 100, `profit protection ${pnl.toFixed(2)}%`);
                return;
            }

            if (!runnerActive && peakGain >= 10) {
                let adaptiveTrailPercent = 15;
                if (peakGain >= 50) adaptiveTrailPercent = 8;
                else if (peakGain >= 30) adaptiveTrailPercent = 10;
                else if (peakGain >= 15) adaptiveTrailPercent = 12;

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

            let transactionBuffer: Uint8Array;
            try {
                transactionBuffer = await getTradeTransaction({
                    publicKey: this.wallet.publicKey.toBase58(),
                    action: 'sell',
                    mint,
                    amount: amountToSell,
                    denominatedInSol: 'false',
                    slippage: Math.max(this.config.slippage, 25),
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
                    slippage: Math.max(this.config.slippage, 50),
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
            const balanceAfter = await getBalance(this.wallet.publicKey.toBase58(), this.connection);
            clearTokenBalanceCache(this.wallet.publicKey.toBase58(), mint);
            const actualRemaining = await getTokenBalance(this.wallet.publicKey.toBase58(), mint, this.connection);
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
        const revenue = soldTokenAmount * position.currentPrice * 0.97;
        const costBasis = position.amountSolPaid * sellFraction;
        const realizedProfit = revenue - costBasis;

        this.state.totals.realizedProfitSol += realizedProfit;

        const remainingFraction = Math.max(0, 1 - sellFraction);
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

        this.log(`[DRY RUN] Sold ${amountPercent}% of ${position.symbol}: ${realizedProfit >= 0 ? '+' : ''}${realizedProfit.toFixed(4)} SOL (${reason})`);
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
        this.state.openPositions = this.state.openPositions.filter((item) => item.mint !== position.mint);
        this.state.closedPositions.unshift({
            ...position,
            status: 'closed',
            closeReason: reason,
            closeTime: position.closeTime || Date.now()
        });
        this.state.closedPositions = this.state.closedPositions.slice(0, 200);
        this.state.totals.trades += 1;
        if (position.realizedProfitSol > 0) {
            this.state.totals.wins += 1;
        } else {
            this.state.totals.losses += 1;
        }
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
