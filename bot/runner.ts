import WebSocket from 'ws';
import { createConnection, getBalance, getPumpData, getTokenBalance } from '../utils/solanaManager';
import { getTradeTransaction, signAndSendTransaction } from '../utils/pumpPortal';
import { detectRug } from '../utils/rugDetector';
import { analyzeEnhanced } from '../utils/enhancedAnalyzer';
import { clearMarketSnapshot, getMarketSnapshot, recordMarketEvent } from '../utils/marketData';
import { mergeTokenData, normalizeTokenEvent } from '../utils/tokenFeed';
import { getConfiguredWallet, loadRunnerConfig } from './config';
import { loadState, saveState } from './stateStore';
import type { TokenData } from '../types/token';
import type { BotMode, BotState, ManagedExitStrategy, ManagedPosition, RunnerConfig } from './types';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPercent(percent: number): number {
    return Math.max(0, Math.min(100, percent));
}

function calculatePrice(liquiditySol: number, virtualTokens: number): number {
    if (!liquiditySol || !virtualTokens) return 0;
    return (liquiditySol / virtualTokens) * 1_000_000;
}

function getRugMode(mode: BotMode): 'safe' | 'medium' | 'high' {
    if (mode === 'degen' || mode === 'velocity' || mode === 'high') return 'high';
    if (mode === 'sniper' || mode === 'first' || mode === 'scalp') return 'medium';
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
            this.log(`Health: ${this.state.openPositions.length} open position(s), realized ${this.state.totals.realizedProfitSol.toFixed(4)} SOL`);
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

            const amountSol = await this.getTradeSize(analysis.score);
            if (amountSol <= 0) return;

            const exitStrategy = this.buildExitStrategy(token, analysis.score);
            await this.executeBuy(token, amountSol, exitStrategy, analysis.score, analysis.riskLevel, analysis.reasons);
        } catch (error: any) {
            this.log(`Analysis error for ${token.symbol}: ${error.message}`);
        } finally {
            this.analyzingMints.delete(token.mint);
        }
    }

    private async getTradeSize(score: number): Promise<number> {
        let amount = this.config.amountSol;

        if (this.config.dynamicSizing) {
            if (score >= 90) amount *= 1.5;
            else if (score >= 80) amount *= 1.25;
            else if (score < 70) amount *= 0.75;
        }

        if (!this.wallet) {
            return Number(amount.toFixed(4));
        }

        const balance = await getBalance(this.wallet.publicKey.toBase58(), this.connection);
        if (balance === null) return 0;

        const maxSpendable = Math.max(0, balance - this.config.minBalanceReserveSol);
        if (maxSpendable <= 0) return 0;

        return Number(Math.min(amount, maxSpendable).toFixed(4));
    }

    private buildExitStrategy(token: TokenData, score: number): ManagedExitStrategy {
        const snapshot = getMarketSnapshot(token.mint);
        const exit: ManagedExitStrategy = { ...this.config.defaultExit };

        if (snapshot?.buyPressure && snapshot.buyPressure > 0.8) {
            exit.takeProfit = Math.max(exit.takeProfit, exit.takeProfit + 10);
            if (exit.takeProfit2) {
                exit.takeProfit2 += 25;
            }
            exit.trailingStopPercent = Math.max(6, (exit.trailingStopPercent || 10) - 2);
        }

        if (score >= 90) {
            exit.maxHoldTime = Math.round(exit.maxHoldTime * 1.25);
            if (exit.takeProfit2) {
                exit.takeProfit2 += 50;
            }
        }

        if (this.config.mode === 'sniper' || this.config.mode === 'first' || this.config.mode === 'scalp') {
            exit.takeProfit2 = undefined;
            exit.maxHoldTime = Math.min(exit.maxHoldTime, 180);
        }

        return exit;
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
            const actualTokens = await getTokenBalance(this.wallet.publicKey.toBase58(), token.mint, this.connection);
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

            this.log(`Buy confirmed for ${token.symbol}: ${actualTokens.toFixed(4)} tokens`);
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
                const walletBalance = await getTokenBalance(this.wallet.publicKey.toBase58(), mint, this.connection);
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

            this.replaceOpenPosition(nextPosition);

            if (position.lastLiquidity && position.lastLiquidity > 5) {
                const liquidityDrop = (position.lastLiquidity - pumpData.vSolInBondingCurve) / position.lastLiquidity;
                if (liquidityDrop > 0.2) {
                    await this.executeSell(mint, 100, 'liquidity drop >20%');
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

            if (holdTime >= nextPosition.exitStrategy.maxHoldTime) {
                await this.executeSell(mint, 100, `time limit ${nextPosition.exitStrategy.maxHoldTime}s`);
                return;
            }

            if (pnl <= -Math.abs(nextPosition.exitStrategy.stopLoss)) {
                await this.executeSell(mint, 100, `stop loss ${pnl.toFixed(2)}%`);
                return;
            }

            const hasStagedExit = !!nextPosition.exitStrategy.takeProfit2 || nextPosition.exitStrategy.trailingStop;
            if (pnl >= nextPosition.exitStrategy.takeProfit && !nextPosition.partialSells.tp1) {
                const percent = hasStagedExit ? 50 : 100;
                await this.executeSell(mint, percent, `take profit ${pnl.toFixed(2)}%`);
                return;
            }

            if (nextPosition.exitStrategy.takeProfit2 && pnl >= nextPosition.exitStrategy.takeProfit2 && !nextPosition.partialSells.tp2) {
                await this.executeSell(mint, 30, `take profit 2 ${pnl.toFixed(2)}%`);
                return;
            }

            if (nextPosition.exitStrategy.trailingStop && peakGain >= 10) {
                const trailingStopPercent = nextPosition.exitStrategy.trailingStopPercent || 10;
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

    private async executeSell(mint: string, amountPercent: number, reason: string): Promise<void> {
        const position = this.state.openPositions.find((item) => item.mint === mint);
        if (!position || this.processingMints.has(mint)) return;

        this.processingMints.add(mint);
        const normalizedPercent = clampPercent(amountPercent);

        try {
            if (this.config.dryRun) {
                await this.applyDryRunSell(position, normalizedPercent, reason);
                return;
            }

            if (!this.wallet) {
                throw new Error('Live mode requires a configured wallet');
            }

            const tokenBalance = await getTokenBalance(this.wallet.publicKey.toBase58(), mint, this.connection);
            if (tokenBalance <= 0) {
                await this.forceCloseWorthlessPosition(position, `${reason} (no balance)`);
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
                    pool: 'pump'
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
                    pool: 'pump'
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
                    ...(normalizedPercent === 50 ? { tp1: true } : {}),
                    ...(normalizedPercent === 30 ? { tp2: true } : {})
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

    private async applyDryRunSell(position: ManagedPosition, amountPercent: number, reason: string): Promise<void> {
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
                ...(amountPercent === 50 ? { tp1: true } : {}),
                ...(amountPercent === 30 ? { tp2: true } : {})
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
            const balance = await getTokenBalance(this.wallet.publicKey.toBase58(), position.mint, this.connection);
            if (balance <= 0) {
                await this.forceCloseWorthlessPosition(position, 'startup reconciliation');
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
