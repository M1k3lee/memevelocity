import { useState, useEffect, useRef, useCallback } from 'react';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { toast } from 'sonner';
import { getTradeTransaction, signAndSendTransaction } from '../utils/pumpPortal';
import { clearTokenBalanceCache, getBalance, getTokenBalance, getPumpPrice, getTokenMetadata, getPumpData } from '../utils/solanaManager';
import { getMarketSnapshot, recordMarketEvent } from '../utils/marketData';
import { formatTokenPrice } from '../utils/priceFormat';
import { fitTradeAmountToBalance } from '../utils/tradeSizing';
import { recordLatestToken } from '../utils/liveTokenStore';
import type { TokenData } from '../types/token';
import { mergeTokenData, normalizeTokenEvent } from '../utils/tokenFeed';
import { calculatePumpPrice } from '../utils/pumpMath';

const LIVE_TRADE_SETTLEMENT_WARMUP_SECONDS = 20;

function getLiveExitWarmupSeconds(trade?: Pick<ActiveTrade, 'exitStrategy'>): number {
    if (trade?.exitStrategy?.maxHoldTime && trade.exitStrategy.maxHoldTime <= 90) {
        return 6;
    }
    if (trade?.exitStrategy?.maxHoldTime && trade.exitStrategy.maxHoldTime <= 120) {
        return 10;
    }
    return LIVE_TRADE_SETTLEMENT_WARMUP_SECONDS;
}

function sanitizePaperObservedPrice(trade: ActiveTrade, candidatePrice: number): number {
    if (!Number.isFinite(candidatePrice) || candidatePrice <= 0) {
        return 0;
    }

    if (trade.buyPrice > 0) {
        const ratioToBuy = candidatePrice / trade.buyPrice;
        if (ratioToBuy > 50 || ratioToBuy < 0.02) {
            if (trade.currentPrice > 0) {
                const currentRatioToBuy = trade.currentPrice / trade.buyPrice;
                if (currentRatioToBuy <= 50 && currentRatioToBuy >= 0.02) {
                    return trade.currentPrice;
                }
            }
            return trade.buyPrice;
        }
    }

    const referencePrice =
        trade.currentPrice > 0
            ? trade.currentPrice
            : (trade.highestPrice && trade.highestPrice > 0
                ? trade.highestPrice
                : trade.buyPrice);

    if (referencePrice > 0) {
        const ratio = candidatePrice / referencePrice;
        if (ratio > 8 || ratio < 0.125) {
            return referencePrice;
        }
    }

    return candidatePrice;
}

export interface ActiveTrade {
    mint: string;
    symbol: string;
    buyPrice: number; // SOL per token
    amountTokens: number; // Token balance
    amountSolPaid?: number; // Original SOL used
    currentPrice: number;
    pnlPercent: number;
    realizedPnlSol?: number;
    status: "open" | "selling" | "closed";
    txId?: string;
    lastPriceUpdate?: number;
    lastPriceChangeTime?: number;
    buyTime?: number; // Timestamp when bought
    highestPrice?: number; // For trailing stop
    exitStrategy?: {
        takeProfit: number;
        takeProfit2?: number; // Second profit target (for staged exits)
        stopLoss: number;
        maxHoldTime: number; // seconds
        trailingStop: boolean;
        trailingStopPercent?: number; // e.g., 10% from peak
        momentumExit?: boolean; // Exit when momentum detected (for first buyer)
        minHoldTime?: number; // Minimum seconds before exit (for first buyer)
    };
    partialSells?: { [percent: number]: boolean }; // Track staged sells (50%, 30%, etc.)
    originalAmount?: number; // Track original position size for partial sells
    lastLiquidity?: number; // Track liquidity for rug detection
    isPaper?: boolean; // New: Tracks if this was a demo/paper trade
}

type SellSnapshot = Partial<Pick<ActiveTrade, 'buyPrice' | 'currentPrice' | 'pnlPercent' | 'highestPrice' | 'lastPriceUpdate' | 'lastPriceChangeTime' | 'lastLiquidity'>>;

export const usePumpTrader = (wallet: Keypair | null, connection: Connection, heliusKey?: string) => {
    const [activeTrades, setActiveTrades] = useState<ActiveTrade[]>([]);
    const [tradeHistory, setTradeHistory] = useState<ActiveTrade[]>([]);
    const [logs, setLogs] = useState<string[]>([]);
    const [isDemo, setIsDemo] = useState(false);
    const [demoBalance, setDemoBalance] = useState(10.0);
    const [stats, setStats] = useState({ totalProfit: 0, wins: 0, losses: 0 });
    const [isCleaning, setIsCleaning] = useState(false);
    const processingMintsRef = useRef<Set<string>>(new Set());
    const activeTradesRef = useRef<ActiveTrade[]>([]);

    // Profit Protection Vault
    const [vaultBalance, setVaultBalance] = useState(0);
    const [profitProtectionEnabled, setProfitProtectionEnabled] = useState(true);
    const [profitProtectionPercent, setProfitProtectionPercent] = useState(25);

    const wsRef = useRef<WebSocket | null>(null);
    const lastWebsocketRefreshRef = useRef(0);
    const marketFeedCacheRef = useRef<Map<string, TokenData>>(new Map());

    // Initial Load
    useEffect(() => {
        const savedTrades = localStorage.getItem('pump_active_trades');
        if (savedTrades) {
            try { setActiveTrades(JSON.parse(savedTrades)); } catch (e) { }
        }
        const savedHistory = localStorage.getItem('pump_trade_history');
        if (savedHistory) {
            try { setTradeHistory(JSON.parse(savedHistory)); } catch (e) { }
        }
        const savedLogs = localStorage.getItem('pump_logs');
        if (savedLogs) {
            try { setLogs(JSON.parse(savedLogs)); } catch (e) { }
        }
        const savedStats = localStorage.getItem('pump_stats');
        if (savedStats) {
            try {
                const s = JSON.parse(savedStats);
                setStats(s);
            } catch (e) { }
        }
        const savedVault = localStorage.getItem('pump_vault_balance');
        if (savedVault) {
            try { setVaultBalance(parseFloat(savedVault)); } catch (e) { }
        }
        const savedProtectionEnabled = localStorage.getItem('pump_profit_protection_enabled');
        if (savedProtectionEnabled !== null) {
            try { setProfitProtectionEnabled(savedProtectionEnabled === 'true'); } catch (e) { }
        }
        const savedProtectionPercent = localStorage.getItem('pump_profit_protection_percent');
        if (savedProtectionPercent) {
            try { setProfitProtectionPercent(parseInt(savedProtectionPercent)); } catch (e) { }
        }
    }, []);

    // Persistence
    useEffect(() => {
        activeTradesRef.current = activeTrades;
        localStorage.setItem('pump_active_trades', JSON.stringify(activeTrades));
    }, [activeTrades]);

    useEffect(() => {
        localStorage.setItem('pump_trade_history', JSON.stringify(tradeHistory.slice(0, 100)));
    }, [tradeHistory]);

    useEffect(() => {
        localStorage.setItem('pump_logs', JSON.stringify(logs.slice(0, 50)));
    }, [logs]);

    useEffect(() => {
        localStorage.setItem('pump_stats', JSON.stringify(stats));
    }, [stats]);

    useEffect(() => {
        localStorage.setItem('pump_vault_balance', vaultBalance.toString());
    }, [vaultBalance]);

    useEffect(() => {
        localStorage.setItem('pump_profit_protection_enabled', profitProtectionEnabled.toString());
    }, [profitProtectionEnabled]);

    useEffect(() => {
        localStorage.setItem('pump_profit_protection_percent', profitProtectionPercent.toString());
    }, [profitProtectionPercent]);

    const setDemoMode = (enabled: boolean) => setIsDemo(enabled);

    const addLog = useCallback((msg: string) => setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 50)), []);

    const clearLogs = useCallback(() => {
        setLogs([]);
        localStorage.removeItem('pump_logs');
    }, []);

    const recordTradeFeedEvent = useCallback((payload: any) => {
        if (!payload?.mint) return;

        const normalized = normalizeTokenEvent(payload, Date.now());
        const merged = mergeTokenData(marketFeedCacheRef.current.get(normalized.mint), normalized);
        marketFeedCacheRef.current.set(merged.mint, merged);
        recordLatestToken(merged);
        recordMarketEvent(merged);
    }, []);

    const withRpcTimeout = useCallback(async <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
            })
        ]);
    }, []);

    const reclaimMintAccountRent = useCallback(async (mint: string): Promise<number> => {
        if (!wallet || isDemo) return 0;

        try {
            const [{ PublicKey, Transaction }, { TOKEN_PROGRAM_ID, createCloseAccountInstruction }] = await Promise.all([
                import('@solana/web3.js'),
                import('@solana/spl-token')
            ]);

            const accounts = await withRpcTimeout(
                connection.getParsedTokenAccountsByOwner(
                    wallet.publicKey,
                    { mint: new PublicKey(mint) }
                ),
                12000,
                'Rent reclaim account scan'
            );

            const emptyAccounts = accounts.value.filter(acc => {
                const uiAmount = acc.account.data.parsed.info.tokenAmount.uiAmount || 0;
                return uiAmount <= 0;
            });

            if (emptyAccounts.length === 0) {
                return 0;
            }

            const balanceBefore = await getBalance(wallet.publicKey.toBase58(), connection);
            const transaction = new Transaction();
            emptyAccounts.forEach(acc => {
                transaction.add(
                    createCloseAccountInstruction(acc.pubkey, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID)
                );
            });

            const { blockhash } = await withRpcTimeout(
                connection.getLatestBlockhash(),
                10000,
                'Rent reclaim blockhash fetch'
            );
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = wallet.publicKey;
            transaction.sign(wallet);

            const signature = await withRpcTimeout(
                connection.sendRawTransaction(transaction.serialize()),
                10000,
                'Rent reclaim transaction send'
            );
            await withRpcTimeout(
                connection.confirmTransaction(signature, 'confirmed'),
                20000,
                'Rent reclaim confirmation'
            );
            await new Promise(resolve => setTimeout(resolve, 1000));

            const balanceAfter = await getBalance(wallet.publicKey.toBase58(), connection);
            if (balanceBefore === null || balanceAfter === null) {
                return 0;
            }

            return Math.max(0, balanceAfter - balanceBefore);
        } catch {
            return 0;
        }
    }, [wallet, isDemo, connection, withRpcTimeout]);

    const syncLiveTradeFromWallet = useCallback(async (mint: string, settledAmountSol?: number) => {
        if (!wallet || isDemo) return false;

        const walletPubkey = wallet.publicKey.toBase58();
        clearTokenBalanceCache(walletPubkey, mint);
        const balance = await getTokenBalance(walletPubkey, mint, connection);
        if (balance <= 0) return false;

        const existingTrade = activeTradesRef.current.find(t => t.mint === mint);
        const amountSolPaid = settledAmountSol && settledAmountSol > 0
            ? settledAmountSol
            : (existingTrade?.amountSolPaid || existingTrade?.originalAmount || 0);
        const derivedBuyPrice = amountSolPaid > 0 ? amountSolPaid / balance : (existingTrade?.buyPrice || 0);
        const now = Date.now();

        setActiveTrades(prev => prev.map(t => {
            if (t.mint !== mint) return t;

            const nextCurrentPrice = t.currentPrice > 0
                ? t.currentPrice
                : (derivedBuyPrice > 0 ? derivedBuyPrice : 0);
            const nextHighestPrice = t.highestPrice && t.highestPrice > 0
                ? t.highestPrice
                : nextCurrentPrice;

            return {
                ...t,
                amountTokens: balance,
                amountSolPaid: amountSolPaid > 0 ? amountSolPaid : t.amountSolPaid,
                originalAmount: amountSolPaid > 0 ? amountSolPaid : t.originalAmount,
                buyPrice: derivedBuyPrice > 0 ? derivedBuyPrice : t.buyPrice,
                currentPrice: nextCurrentPrice,
                highestPrice: nextHighestPrice,
                lastPriceUpdate: t.lastPriceUpdate || now,
                lastPriceChangeTime: t.lastPriceChangeTime || now
            };
        }));

        return true;
    }, [wallet, isDemo, connection]);

    const confirmLiveTokenBalance = useCallback(async (mint: string, attempts: number = 3, delayMs: number = 1200): Promise<number> => {
        if (!wallet || isDemo) return 0;

        const walletPubkey = wallet.publicKey.toBase58();
        let balance = 0;

        for (let attempt = 0; attempt < attempts; attempt++) {
            clearTokenBalanceCache(walletPubkey, mint);
            balance = await getTokenBalance(walletPubkey, mint, connection);
            if (balance > 0) {
                return balance;
            }

            if (attempt < attempts - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        return balance;
    }, [wallet, isDemo, connection]);

    const getWalletSolDeltaFromSignature = useCallback(async (signature: string): Promise<number | null> => {
        if (!wallet || isDemo) return null;

        const walletPubkey = wallet.publicKey.toBase58();

        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                const tx = await connection.getParsedTransaction(signature, {
                    commitment: 'confirmed',
                    maxSupportedTransactionVersion: 0
                });

                const accountKeys = (tx?.transaction.message.accountKeys || []) as Array<any>;
                const walletIndex = accountKeys.findIndex((key: any) => {
                    if (key?.pubkey?.toBase58) return key.pubkey.toBase58() === walletPubkey;
                    if (key?.toBase58) return key.toBase58() === walletPubkey;
                    return false;
                });

                if (
                    tx?.meta &&
                    walletIndex >= 0 &&
                    tx.meta.preBalances[walletIndex] !== undefined &&
                    tx.meta.postBalances[walletIndex] !== undefined
                ) {
                    return (tx.meta.postBalances[walletIndex] - tx.meta.preBalances[walletIndex]) / LAMPORTS_PER_SOL;
                }
            } catch {
                // Retry below when RPC is rate-limited or transaction indexing lags.
            }

            await new Promise(resolve => setTimeout(resolve, 750 * (attempt + 1)));
        }

        return null;
    }, [wallet, isDemo, connection]);

    // Define sellToken early so it can be used in useEffect
    const sellToken = useCallback(async (mint: string, amountPercent: number = 100, snapshot?: SellSnapshot) => {
        if (!wallet && !isDemo) return;
        if (processingMintsRef.current.has(mint)) return;

        const trade = activeTradesRef.current.find(t => t.mint === mint);
        if (!trade || trade.status === "closed" || trade.status === "selling") return;
        const effectiveTrade = snapshot ? { ...trade, ...snapshot } : trade;

        processingMintsRef.current.add(mint);
        addLog(`Attempting to SELL ${amountPercent}% of ${effectiveTrade.symbol}...`);

        try {
            if (isDemo) {
                const sellFraction = Math.max(0, Math.min(100, amountPercent)) / 100;
                const soldTokenAmount = (effectiveTrade.amountTokens || 0) * sellFraction;
                let sellPrice = sanitizePaperObservedPrice(effectiveTrade, effectiveTrade.currentPrice || 0);
                try {
                    const pumpData = await getPumpData(mint, connection);
                    if (pumpData?.vTokensInBondingCurve && pumpData.vSolInBondingCurve > 0) {
                        const livePrice = calculatePumpPrice(pumpData.vSolInBondingCurve, pumpData.vTokensInBondingCurve);
                        sellPrice = sanitizePaperObservedPrice(effectiveTrade, livePrice);
                    } else {
                        const snapshot = getMarketSnapshot(mint);
                        if (snapshot?.currentPrice && snapshot.currentPrice > 0) {
                            sellPrice = sanitizePaperObservedPrice(effectiveTrade, snapshot.currentPrice);
                        }
                    }
                } catch {
                    const snapshot = getMarketSnapshot(mint);
                    if (snapshot?.currentPrice && snapshot.currentPrice > 0) {
                        sellPrice = sanitizePaperObservedPrice(effectiveTrade, snapshot.currentPrice);
                    }
                }
                const costBasis = (effectiveTrade.buyPrice || 0) * soldTokenAmount;

                const isStale = effectiveTrade.lastPriceUpdate && (Date.now() - effectiveTrade.lastPriceUpdate > 120000);
                const effectiveSellPrice = isStale ? 0 : sellPrice;

                const rawRevenue = soldTokenAmount * effectiveSellPrice;
                const revenue = rawRevenue * 0.97; // 3% friction on the token sale itself
                const rentReclaim = amountPercent >= 99 ? 0.00204 : 0;
                const tradingProfit = revenue - costBasis;
                const realizedPnlPercent = costBasis > 0 ? (tradingProfit / costBasis) * 100 : 0;
                const displayExitPrice = soldTokenAmount > 0 ? (revenue / soldTokenAmount) : effectiveSellPrice;

                setDemoBalance(prev => prev + costBasis + tradingProfit + rentReclaim);

                setStats(prev => ({
                    totalProfit: prev.totalProfit + tradingProfit,
                    wins: tradingProfit > 0 ? prev.wins + 1 : prev.wins,
                    losses: tradingProfit <= 0 ? prev.losses + 1 : prev.losses
                }));

                const closedTrade: ActiveTrade = {
                    ...effectiveTrade,
                    status: "closed" as const,
                    currentPrice: displayExitPrice,
                    pnlPercent: realizedPnlPercent,
                    realizedPnlSol: tradingProfit,
                    isPaper: true
                };

                if (amountPercent >= 99) {
                    setTradeHistory(prev => {
                        if (prev.some(t => t.mint === mint && Math.abs((t.buyTime || 0) - (effectiveTrade.buyTime || 0)) < 1000)) return prev;
                        return [closedTrade, ...prev].slice(0, 100);
                    });
                    setActiveTrades(prev => prev.filter(t => t.mint !== mint));
                } else {
                    const remainingFraction = Math.max(0, 1 - sellFraction);
                    setActiveTrades(prev => prev.map(t => t.mint === mint ? {
                        ...t,
                        status: "open",
                        amountTokens: (t.amountTokens || 0) * remainingFraction,
                        amountSolPaid: (t.amountSolPaid || 0) * remainingFraction,
                        currentPrice: effectiveSellPrice,
                        realizedPnlSol: undefined,
                        pnlPercent: t.buyPrice > 0 ? ((effectiveSellPrice - t.buyPrice) / t.buyPrice) * 100 : 0
                    } : t));
                }

                addLog(`[DEMO] Sold ${amountPercent}% at ${formatTokenPrice(sellPrice)} SOL. Trade PnL: ${tradingProfit.toFixed(4)} SOL`);
                if (rentReclaim > 0) {
                    addLog(`[DEMO] Recovered ${rentReclaim.toFixed(4)} SOL token-account rent on close (excluded from PnL%).`);
                }
                processingMintsRef.current.delete(mint);
                return;
            }

            if (!wallet) return;

            const balance = await confirmLiveTokenBalance(mint, 3, 1000);
            const liveExitWarmupSeconds = getLiveExitWarmupSeconds(effectiveTrade);
            if (balance === 0) {
                const ageMs = Date.now() - (effectiveTrade.buyTime || 0);
                if (ageMs < liveExitWarmupSeconds * 1000) {
                    setActiveTrades(prev => prev.map(t => t.mint === mint ? { ...t, status: "open" } : t));
                    return;
                }

                addLog(`Sell: Could not verify ${effectiveTrade.symbol} wallet balance after repeated checks. Leaving the trade open until sync confirms it.`);
                setActiveTrades(prev => prev.map(t => t.mint === mint ? { ...t, status: "open" } : t));
                return;
            }

            const amountToSell = balance * (amountPercent / 100);
            const tradeAmountPaid = effectiveTrade.amountSolPaid || 0.03;

            setActiveTrades(prev => prev.map(t => t.mint === mint ? { ...t, status: "selling" } : t));

            const priorityFee = tradeAmountPaid <= 0.05 ? 0.0003 : Math.max(0.0005, Math.min(0.002, tradeAmountPaid * 0.02));

            let transactionBuffer;
            try {
                transactionBuffer = await getTradeTransaction({
                    publicKey: wallet.publicKey.toBase58(),
                    action: "sell",
                    mint,
                    amount: amountToSell,
                    denominatedInSol: "false",
                    slippage: 25,
                    priorityFee,
                    pool: "auto"
                });
            } catch (err: any) {
                transactionBuffer = await getTradeTransaction({
                    publicKey: wallet.publicKey.toBase58(),
                    action: "sell",
                    mint,
                    amount: amountToSell,
                    denominatedInSol: "false",
                    slippage: 50,
                    priorityFee: 0.003,
                    pool: "auto"
                });
            }

            const balanceBefore = await getBalance(wallet.publicKey.toBase58(), connection);
            const signature = await signAndSendTransaction(connection, transactionBuffer, wallet);
            addLog(`Sell Tx Sent: ${signature.substring(0, 8)}...`);

            const confirmation = await connection.confirmTransaction(signature, 'confirmed');
            if (confirmation.value.err) throw new Error("On-chain execution failed");

            await new Promise(resolve => setTimeout(resolve, 2000));
            const txDelta = await getWalletSolDeltaFromSignature(signature);
            const balanceAfter = txDelta === null ? await getBalance(wallet.publicKey.toBase58(), connection) : null;
            let reclaimedRent = 0;
            if (amountPercent >= 99) {
                reclaimedRent = await reclaimMintAccountRent(mint);
                if (reclaimedRent > 0) {
                    addLog(`Recovered ${reclaimedRent.toFixed(4)} SOL rent from ${effectiveTrade.symbol} (excluded from trade PnL).`);
                }
            }

            let tradeRevenue: number | null = txDelta !== null ? Math.max(0, txDelta) : null;
            if (tradeRevenue === null && balanceBefore !== null && balanceAfter !== null) {
                tradeRevenue = Math.max(0, balanceAfter - balanceBefore);
            }
            if (tradeRevenue === null) {
                const fallbackRevenue = effectiveTrade.currentPrice > 0 ? amountToSell * effectiveTrade.currentPrice : 0;
                tradeRevenue = Math.max(0, fallbackRevenue);
                addLog(`⚠️ ${effectiveTrade.symbol} sell confirmed, but RPC could not verify the exact SOL delta. Using estimated trade revenue.`);
            }

            const costBasis = tradeAmountPaid * (amountPercent / 100);
            const netProfit = tradeRevenue - costBasis;
            const realizedPnlPercent = costBasis > 0 ? (netProfit / costBasis) * 100 : 0;

            if (profitProtectionEnabled && netProfit > 0) {
                const skim = netProfit * (profitProtectionPercent / 100);
                setVaultBalance(prev => prev + skim);
            }

            setStats(prev => ({
                totalProfit: prev.totalProfit + netProfit,
                wins: netProfit > 0 ? prev.wins + 1 : prev.wins,
                losses: netProfit <= 0 ? prev.losses + 1 : prev.losses
            }));

            const finalPnlPercent = Math.max(-100, realizedPnlPercent);

            if (amountPercent >= 99) {
                const closedTrade: ActiveTrade = {
                    ...effectiveTrade,
                    status: "closed" as const,
                    currentPrice: effectiveTrade.currentPrice,
                    pnlPercent: finalPnlPercent,
                    realizedPnlSol: netProfit,
                    txId: signature
                };
                setTradeHistory(prev => {
                    if (prev.some(t => t.mint === mint && Math.abs((t.buyTime || 0) - (effectiveTrade.buyTime || 0)) < 1000)) return prev;
                    return [closedTrade, ...prev].slice(0, 100);
                });
                setActiveTrades(prev => prev.filter(t => t.mint !== mint));
            } else {
                setActiveTrades(prev => prev.map(t => t.mint === mint ? {
                    ...t,
                    status: "open",
                    amountTokens: t.amountTokens * (1 - amountPercent / 100),
                    amountSolPaid: (t.amountSolPaid || 0) * (1 - amountPercent / 100)
                } : t));
            }

            addLog(`✅ Sell Confirmed! Realized: ${netProfit > 0 ? '+' : ''}${netProfit.toFixed(4)} SOL (${realizedPnlPercent.toFixed(1)}%)`);
            toast.success(`Sold ${effectiveTrade.symbol}! PnL: ${netProfit.toFixed(4)} SOL`);

        } catch (error: any) {
            const msg = error.message || "Execution error";
            addLog(`❌ Sell Failed for ${trade.symbol}: ${msg}`);
            if (msg.includes("Account") || msg.includes("not found")) {
                setActiveTrades(prev => prev.filter(t => t.mint !== mint));
                const lossAmount = effectiveTrade.amountSolPaid || 0;
                setStats(prev => ({
                    ...prev,
                    totalProfit: prev.totalProfit - lossAmount,
                    losses: prev.losses + 1
                }));
            } else {
                setActiveTrades(prev => prev.map(t => t.mint === mint ? { ...t, status: "open" } : t));
            }
        } finally {
            processingMintsRef.current.delete(mint);
        }
    }, [wallet, isDemo, connection, addLog, setDemoBalance, setStats, setActiveTrades, setTradeHistory, profitProtectionEnabled, profitProtectionPercent, setVaultBalance, reclaimMintAccountRent, getWalletSolDeltaFromSignature, confirmLiveTokenBalance]);

    // --- PRICE CALCULATION ENGINE ---

    const updatePrices = useCallback(async () => {
        const openTrades = activeTradesRef.current.filter(t => t.status === "open");
        if (openTrades.length === 0) return;

        const tradesToPoll = isDemo ? openTrades : openTrades.slice(0, 10);
        const BATCH_SIZE = 5;
        const updates: Map<string, Partial<ActiveTrade>> = new Map();

        for (let i = 0; i < tradesToPoll.length; i += BATCH_SIZE) {
            const batch = tradesToPoll.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (trade) => {
                try {
                    let price = 0;
                    let currentLiquidity = 0;

                    if (trade.isPaper || isDemo) {
                        const pumpData = await getPumpData(trade.mint, connection);
                        if (pumpData?.vTokensInBondingCurve && pumpData.vSolInBondingCurve > 0) {
                            const livePrice = calculatePumpPrice(pumpData.vSolInBondingCurve, pumpData.vTokensInBondingCurve);
                            price = sanitizePaperObservedPrice(trade, livePrice);
                            currentLiquidity = pumpData.vSolInBondingCurve;
                        } else {
                            const snapshot = getMarketSnapshot(trade.mint);
                            if (snapshot?.currentPrice && snapshot.currentPrice > 0) {
                                price = sanitizePaperObservedPrice(trade, snapshot.currentPrice);
                                currentLiquidity = snapshot.currentLiquiditySol;
                            } else {
                                price = trade.currentPrice > 0 ? trade.currentPrice : trade.buyPrice;
                                currentLiquidity = trade.lastLiquidity || 0;
                            }
                        }
                    } else if (trade.mint.startsWith('SIM') && !isDemo) {
                        const isRug = trade.symbol.includes("Garbage") || trade.symbol.includes("Rug");
                        const basePrice = trade.currentPrice > 0 ? trade.currentPrice : (trade.buyPrice > 0 ? trade.buyPrice : 0.000001);
                        const change = 1 + (Math.random() * 0.1 - 0.05) + (isRug ? -0.01 : 0.005);
                        price = Math.max(0.000001, basePrice * change);
                    } else {
                        try {
                            const pumpData = await getPumpData(trade.mint, connection);
                            if (pumpData) {
                                currentLiquidity = pumpData.vSolInBondingCurve;
                                if (pumpData.vTokensInBondingCurve > 0 && pumpData.vSolInBondingCurve > 0) {
                                    price = calculatePumpPrice(pumpData.vSolInBondingCurve, pumpData.vTokensInBondingCurve);
                                }
                            }
                            if (price === 0) {
                                const fetchedPrice = await getPumpPrice(trade.mint, connection);
                                if (fetchedPrice > 0) price = fetchedPrice;
                            }
                        } catch (error) { price = 0; }
                    }

                    const priceToUse = price > 0 ? price : (trade.currentPrice > 0 ? trade.currentPrice : 0);
                    if (priceToUse > 0) {
                        let buyPrice = trade.buyPrice;
                        const hasSettledPosition = trade.isPaper || isDemo || (trade.amountTokens || 0) > 0;
                        if (hasSettledPosition && (buyPrice === 0 || buyPrice < 0.000000001)) {
                            buyPrice = priceToUse;
                        }

                        const pnl = buyPrice > 0 ? ((priceToUse - buyPrice) / buyPrice) * 100 : 0;
                        const highestPrice = trade.highestPrice ? Math.max(trade.highestPrice, priceToUse) : priceToUse;
                        const lastPriceUpdate = Date.now();
                        const lastPriceChangeTime = priceToUse !== trade.currentPrice ? lastPriceUpdate : trade.lastPriceChangeTime;
                        const nextLiquidity = currentLiquidity > 0 ? currentLiquidity : trade.lastLiquidity;
                        const sellSnapshot: SellSnapshot = {
                            buyPrice,
                            currentPrice: priceToUse,
                            pnlPercent: pnl,
                            highestPrice,
                            lastPriceUpdate,
                            lastPriceChangeTime,
                            lastLiquidity: nextLiquidity
                        };
                        const strategy = trade.exitStrategy || { takeProfit: 30, stopLoss: 15, maxHoldTime: 600, trailingStop: false };
                        const timeOpen = (Date.now() - (trade.buyTime || Date.now())) / 1000; // seconds
                        const liveExitWarmupSeconds = getLiveExitWarmupSeconds(trade);
                        const isFastCompoundTrade = !!strategy.maxHoldTime && strategy.maxHoldTime <= 90;
                        const shouldManageExitsInHook =
                            !isDemo &&
                            !trade.isPaper &&
                            (trade.amountTokens || 0) > 0 &&
                            timeOpen >= liveExitWarmupSeconds;

                        const prevLiq = trade.lastLiquidity || 0;
                        if (shouldManageExitsInHook && prevLiq > 0 && trade.lastPriceUpdate) {
                            const rugDropThreshold = isFastCompoundTrade ? 0.1 : 0.2;
                            if (currentLiquidity > 0 && prevLiq > 5 && (prevLiq - currentLiquidity) / prevLiq > rugDropThreshold) {
                                updates.set(trade.mint, { status: "selling", lastLiquidity: currentLiquidity });
                                sellToken(trade.mint, 100, sellSnapshot);
                                addLog(`🚨 RUG PULL DETECTED: ${trade.symbol} liquidity dropped >${(rugDropThreshold * 100).toFixed(0)}%. Selling!`);
                                return;
                            }
                        }

                        // --- NEW: STRATEGIC EXIT LOGIC (TP/SL/TIME) ---
                        // Ensure strategy exists (backwards compatibility)

                        if (shouldManageExitsInHook && isFastCompoundTrade) {
                            const peakPnl = highestPrice > buyPrice ? ((highestPrice - buyPrice) / buyPrice) * 100 : pnl;
                            if (timeOpen >= 6 && pnl <= -4) {
                                updates.set(trade.mint, { status: "selling" });
                                sellToken(trade.mint, 100, sellSnapshot);
                                addLog(`⚡ FAST KILL: ${trade.symbol} hit ${pnl.toFixed(2)}% in the opening window. Exiting.`);
                                return;
                            }

                            if (timeOpen >= 10 && peakPnl >= 4 && pnl <= 0) {
                                updates.set(trade.mint, { status: "selling" });
                                sellToken(trade.mint, 100, sellSnapshot);
                                addLog(`⚡ FAST GIVEBACK EXIT: ${trade.symbol} faded from ${peakPnl.toFixed(2)}% to ${pnl.toFixed(2)}%. Exiting.`);
                                return;
                            }
                        }

                        // 1. STOP LOSS
                        if (shouldManageExitsInHook && pnl <= -strategy.stopLoss) {
                            updates.set(trade.mint, { status: "selling" });
                            sellToken(trade.mint, 100, sellSnapshot);
                            addLog(`🛑 STOP LOSS: ${trade.symbol} at ${pnl.toFixed(2)}% (Limit: -${strategy.stopLoss}%)`);
                            return;
                        }

                        // 2. TIME LIMIT / STAGNATION (For GOD MODE / SNIPER)
                        // If holding > maxHoldTime (e.g. 10m) and profit is negligible (<5%), EXIT.
                        // Don't hold dead bags.
                        if (shouldManageExitsInHook && strategy.maxHoldTime && timeOpen > strategy.maxHoldTime) {
                            // If we are in deep profit, maybe hold? But if stagnant, sell.
                            // If we are losing, definitely sell.
                            if (pnl < 10) {
                                updates.set(trade.mint, { status: "selling" });
                                sellToken(trade.mint, 100, sellSnapshot);
                                addLog(`⏰ TIME LIMIT: ${trade.symbol} held for ${timeOpen.toFixed(0)}s. Stagnant at ${pnl.toFixed(2)}%. Exiting.`);
                                return;
                            }
                        }

                        // 4. EARLY MOMENTUM CHECK (GOD MODE SPECIAL)
                        // If < 2 mins old, checks strictly for momentum loss? (Can add later)

                        updates.set(trade.mint, {
                            buyPrice,
                            currentPrice: priceToUse,
                            pnlPercent: pnl,
                            highestPrice,
                            lastPriceUpdate,
                            lastPriceChangeTime,
                            lastLiquidity: nextLiquidity
                        });
                    }
                } catch (e) { }
            }));
        }

        if (updates.size > 0) {
            setActiveTrades(prev => prev.map(t => updates.has(t.mint) ? { ...t, ...updates.get(t.mint) } : t));
        }
    }, [connection, isDemo, addLog, sellToken]);

    const openTradeMints = activeTrades
        .filter(t => t.status === "open")
        .map(t => t.mint)
        .sort();
    const openTradeSubscriptionKey = openTradeMints.join(',');
    const hasFastExitTrade = activeTrades.some(t => t.status === "open" && !!t.exitStrategy?.maxHoldTime && t.exitStrategy.maxHoldTime <= 90);

    // WebSocket Hook
    useEffect(() => {
        if (!wallet && !isDemo) return;

        if (!openTradeSubscriptionKey) {
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            return;
        }

        const subscriptionMints = openTradeSubscriptionKey.split(',').filter(Boolean);
        const ws = new WebSocket('wss://pumpportal.fun/api/data');
        wsRef.current = ws;

        ws.onopen = () => {
            ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: subscriptionMints }));
            void updatePrices();
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (!data?.mint || (!data.vSolInBondingCurve && !data.price)) return;

                recordTradeFeedEvent(data);

                const now = Date.now();
                const minRefreshMs = hasFastExitTrade ? 300 : 750;
                if ((now - lastWebsocketRefreshRef.current) < minRefreshMs) return;
                lastWebsocketRefreshRef.current = now;
                void updatePrices();
            } catch {
                // Ignore malformed websocket messages from the live feed.
            }
        };

        return () => {
            if (wsRef.current === ws) {
                wsRef.current = null;
            }
            ws.close();
        };
    }, [wallet, isDemo, openTradeSubscriptionKey, updatePrices, hasFastExitTrade, recordTradeFeedEvent]);

    // Polling Hook (2s Heartbeat)
    useEffect(() => {
        const intervalMs = hasFastExitTrade ? 1000 : 2000;
        const interval = setInterval(updatePrices, intervalMs);
        return () => clearInterval(interval);
    }, [updatePrices, hasFastExitTrade]);

    const subscribeToToken = (mint: string) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
        }
    };

    const buyToken = async (mint: string, symbol: string, amountSol: number, slippage: number = 15, initialPrice?: number, exitStrategy?: ActiveTrade['exitStrategy']) => {
        if (!wallet && !isDemo) {
            addLog("Error: No wallet connected");
            return;
        }

        if (processingMintsRef.current.has(mint)) return;
        processingMintsRef.current.add(mint);

        addLog(`Initiating ${isDemo ? '[DEMO] ' : ''}BUY for ${symbol} (${amountSol} SOL)...`);

        // Default Exit Strategy for God Mode / Sniper (if not provided)
        const activeExitStrategy: ActiveTrade['exitStrategy'] = exitStrategy || {
            takeProfit: 50,
            stopLoss: 15,
            maxHoldTime: 600, // 10 minutes
            trailingStop: false
        };

        if (isDemo) {
            if (demoBalance < amountSol) {
                addLog("[DEMO] Insufficient funds for trade.");
                processingMintsRef.current.delete(mint);
                return;
            }
            if (demoBalance < amountSol * 2) {
                addLog("[DEMO] ⚠️ Low demo balance - stopping.");
                processingMintsRef.current.delete(mint);
                return;
            }

            setDemoBalance(prev => prev - amountSol);
            let buyPrice = initialPrice || await getPumpPrice(mint, connection);
            if (buyPrice === 0) {
                addLog(`[DEMO] ❌ No valid price for ${symbol}. Skipping.`);
                setDemoBalance(prev => prev + amountSol);
                processingMintsRef.current.delete(mint);
                return;
            }

            buyPrice *= 1.015;
            const tradeableSol = (amountSol * 0.99) - 0.00204;
            const amountTokens = tradeableSol / buyPrice;

            const newTrade: ActiveTrade = {
                mint, symbol, buyPrice, amountTokens, amountSolPaid: amountSol,
                currentPrice: buyPrice, pnlPercent: 0, status: "open",
                txId: `DEMO-${Date.now()}`, buyTime: Date.now(), exitStrategy: activeExitStrategy, originalAmount: amountSol,
                highestPrice: buyPrice, lastPriceUpdate: Date.now(), lastPriceChangeTime: Date.now(), partialSells: {}, isPaper: true
            };
            setActiveTrades(prev => [newTrade, ...prev]);
            subscribeToToken(mint);
            toast.success(`[DEMO] Bought ${symbol}`);
            processingMintsRef.current.delete(mint);
            return;
        }

        if (!wallet) return;
        if (activeTrades.some(t => t.mint === mint)) {
            processingMintsRef.current.delete(mint);
            return;
        }

        try {
            const balanceBeforeBuy = await getBalance(wallet.publicKey.toBase58(), connection);
            const bal = await getBalance(wallet.publicKey.toBase58(), connection);
            const sizing = fitTradeAmountToBalance(amountSol, bal);
            const effectiveAmountSol = sizing.fittedAmountSol;

            if (bal === null || effectiveAmountSol <= 0) {
                addLog(`Error: Insufficient balance. Need ${sizing.reserveSol.toFixed(4)} SOL reserved for fees.`);
                return;
            }

            if (sizing.adjusted) {
                addLog(`Micro wallet auto-size: ${symbol} reduced from ${amountSol.toFixed(4)} to ${effectiveAmountSol.toFixed(4)} SOL to keep ${sizing.reserveSol.toFixed(4)} SOL in reserve.`);
            }

            let currentSlippage = slippage;
            let priorityFee = effectiveAmountSol <= 0.05 ? 0.0003 : Math.max(0.001, Math.min(0.003, effectiveAmountSol * 0.05));
            const buildBuyTransaction = async (targetSlippage: number, targetPriorityFee: number) => {
                return getTradeTransaction({
                    publicKey: wallet.publicKey.toBase58(),
                    action: "buy",
                    mint,
                    amount: effectiveAmountSol,
                    denominatedInSol: "true",
                    slippage: targetSlippage,
                    priorityFee: targetPriorityFee,
                    pool: "pump"
                });
            };

            let transactionBuffer = await buildBuyTransaction(currentSlippage, priorityFee);
            let signature: string = "";
            let buyError: any = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    signature = await signAndSendTransaction(connection, transactionBuffer, wallet);
                    buyError = null;
                    break;
                } catch (error: any) {
                    buyError = error;
                    const msg = error?.message || "";
                    const normalizedMsg = msg.toLowerCase();
                    const shouldRetrySlippage =
                        msg.includes("TooMuchSolRequired") ||
                        msg.includes("0x1772") ||
                        normalizedMsg.includes("slippage");
                    const shouldRetryTransport =
                        normalizedMsg.includes("blockhash") ||
                        normalizedMsg.includes("timeout") ||
                        normalizedMsg.includes("timed out") ||
                        normalizedMsg.includes("429") ||
                        normalizedMsg.includes("rate limit") ||
                        normalizedMsg.includes("node is behind") ||
                        normalizedMsg.includes("transport") ||
                        normalizedMsg.includes("service unavailable") ||
                        normalizedMsg.includes("temporarily unavailable") ||
                        normalizedMsg.includes("failed to send");
                    const shouldRetryBuy = shouldRetrySlippage || shouldRetryTransport;

                    if (!shouldRetryBuy || attempt === 2) {
                        break;
                    }

                    currentSlippage = Math.min(
                        Math.max(currentSlippage + (shouldRetrySlippage ? 15 : 10), 45),
                        65
                    );
                    priorityFee = Math.min(0.0045, priorityFee + (shouldRetrySlippage ? 0.0007 : 0.0009));
                    addLog(
                        shouldRetrySlippage
                            ? `Buy retry ${attempt + 1}/2: ${symbol} moved too fast. Retrying with ${currentSlippage}% slippage.`
                            : `Buy retry ${attempt + 1}/2: ${symbol} hit a submit issue. Retrying with ${currentSlippage}% slippage and higher priority.`
                    );
                    transactionBuffer = await buildBuyTransaction(currentSlippage, priorityFee);
                }
            }
            if (buyError) {
                throw buyError;
            }
            addLog(`Buy Tx Sent: ${signature.substring(0, 8)}...`);

            const newTrade: ActiveTrade = {
                mint, symbol, buyPrice: 0, amountTokens: 0, amountSolPaid: effectiveAmountSol,
                currentPrice: 0, pnlPercent: 0, status: "open", txId: signature,
                buyTime: Date.now(), exitStrategy: activeExitStrategy, originalAmount: effectiveAmountSol, partialSells: {}
            };

            setActiveTrades(prev => [newTrade, ...prev]);
            subscribeToToken(mint);

            void connection.confirmTransaction(signature, 'confirmed').then(async (res) => {
                if (!res.value.err) {
                    const txDelta = await getWalletSolDeltaFromSignature(signature);
                    const balanceAfterBuy = txDelta === null ? await getBalance(wallet.publicKey.toBase58(), connection) : null;
                    const actualSpentSol =
                        txDelta !== null
                            ? Math.max(0, -txDelta)
                            : (balanceBeforeBuy !== null && balanceAfterBuy !== null
                                ? Math.max(0, balanceBeforeBuy - balanceAfterBuy)
                                : effectiveAmountSol);

                    let settled = false;
                    for (let attempt = 0; attempt < 7; attempt++) {
                        if (attempt > 0) {
                            await new Promise(r => setTimeout(r, 1500));
                        }

                        clearTokenBalanceCache(wallet.publicKey.toBase58(), mint);
                        settled = await syncLiveTradeFromWallet(mint, actualSpentSol);
                        if (settled) break;
                    }

                    if (!settled) {
                        addLog(`⚠️ ${symbol} buy confirmed, but token balance is still settling. Portfolio sync will keep correcting the entry.`);
                    }
                } else {
                    setActiveTrades(prev => prev.filter(t => t.mint !== mint));
                }
                setTimeout(() => { void syncTrades(); }, 4000);
            }).catch((error: any) => {
                addLog(`Buy confirmation lag for ${symbol}: ${error.message || error}`);
                setTimeout(() => { void syncTrades(); }, 4000);
            });
        } catch (error: any) {
            addLog(`Buy Failed: ${error.message}`);
        } finally {
            processingMintsRef.current.delete(mint);
        }
    };

    const syncTrades = async () => {
        if (isDemo || !wallet) return;
        addLog("Syncing portfolio...");
        for (const trade of activeTradesRef.current.filter(t => t.status === "open")) {
            try {
                const balanceChecks = (trade.amountTokens || 0) <= 0 ? 3 : 1;
                const bal = await confirmLiveTokenBalance(trade.mint, balanceChecks, 1000);
                if (bal > 0) {
                    const normalizedBuyPrice = (trade.amountSolPaid || 0) > 0 ? (trade.amountSolPaid || 0) / bal : trade.buyPrice;
                    setActiveTrades(prev => prev.map(t => t.mint === trade.mint ? {
                        ...t,
                        amountTokens: bal,
                        buyPrice: normalizedBuyPrice > 0 ? normalizedBuyPrice : t.buyPrice,
                        currentPrice: t.currentPrice > 0 ? t.currentPrice : (normalizedBuyPrice > 0 ? normalizedBuyPrice : t.currentPrice),
                        highestPrice: t.highestPrice && t.highestPrice > 0
                            ? t.highestPrice
                            : (t.currentPrice > 0 ? t.currentPrice : (normalizedBuyPrice > 0 ? normalizedBuyPrice : t.highestPrice))
                    } : t));
                } else if (Date.now() - (trade.buyTime || 0) > 60000) {
                    addLog(`Sync: ${trade.symbol} still has no verified token balance after repeated checks. Keeping the trade open for manual or later recovery.`);
                }
            } catch (e) { }
        }
    };

    const cleanupWaste = async () => {
        if (!wallet || isDemo) return;
        setIsCleaning(true);
        addLog("Cleanup in progress...");
        try {
            const { Transaction } = await import('@solana/web3.js');
            const { TOKEN_PROGRAM_ID, createCloseAccountInstruction } = await import('@solana/spl-token');
            addLog("Scanning wallet for empty token accounts...");
            const accounts = await withRpcTimeout(
                connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID }),
                12000,
                'Cleanup account scan'
            );
            const toClose = accounts.value
                .filter(acc => acc.account.data.parsed.info.tokenAmount.uiAmount <= 0 && !activeTradesRef.current.some(t => t.mint === acc.account.data.parsed.info.mint))
                .slice(0, 20);
            if (toClose.length === 0) {
                addLog("No empty token accounts found to close.");
                return;
            }
            addLog(`Found ${toClose.length} empty account${toClose.length === 1 ? '' : 's'}. Preparing cleanup transaction...`);
            const transaction = new Transaction();
            toClose.forEach(acc => transaction.add(createCloseAccountInstruction(acc.pubkey, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID)));
            const { blockhash } = await withRpcTimeout(
                connection.getLatestBlockhash(),
                10000,
                'Cleanup blockhash fetch'
            );
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = wallet.publicKey;
            transaction.sign(wallet);
            const sig = await withRpcTimeout(
                connection.sendRawTransaction(transaction.serialize()),
                10000,
                'Cleanup transaction send'
            );
            addLog(`Cleanup Tx Sent: ${sig.substring(0, 8)}...`);
            await withRpcTimeout(
                connection.confirmTransaction(sig, 'confirmed'),
                20000,
                'Cleanup confirmation'
            );
            addLog(`Rescued ${(toClose.length * 0.00204).toFixed(4)} SOL`);
        } catch (e: any) {
            addLog(`Cleanup Failed: ${e.message}`);
        } finally {
            setIsCleaning(false);
        }
    };

    const recoverTrades = async () => {
        if (isDemo || !wallet) return;
        addLog("Scanning for untracked tokens...");
        try {
            const { PublicKey } = await import('@solana/web3.js');
            const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
            for (const acc of accounts.value) {
                const info = acc.account.data.parsed.info;
                if (info.tokenAmount.uiAmount > 0 && !activeTrades.some(t => t.mint === info.mint) && info.mint.endsWith('pump')) {
                    const meta = await getTokenMetadata(info.mint, heliusKey);
                    const price = await getPumpPrice(info.mint, connection);
                    setActiveTrades(prev => [{ mint: info.mint, symbol: meta.symbol, buyPrice: price, amountTokens: info.tokenAmount.uiAmount, amountSolPaid: info.tokenAmount.uiAmount * price, currentPrice: price, pnlPercent: 0, status: "open", buyTime: Date.now() }, ...prev]);
                }
            }
            addLog("Scan complete.");
        } catch (e: any) { addLog(`Scan Error: ${e.message}`); }
    };

    const clearTrades = () => {
        setActiveTrades([]); setTradeHistory([]); setStats({ totalProfit: 0, wins: 0, losses: 0 });
        localStorage.removeItem('pump_active_trades'); localStorage.removeItem('pump_trade_history'); localStorage.removeItem('pump_stats');
        addLog("Summary: Reset complete.");
    };

    const updateTrade = (mint: string, updates: Partial<ActiveTrade>) => {
        setActiveTrades(prev => prev.map(t => t.mint === mint ? { ...t, ...updates } : t));
    };

    const withdrawFromVault = (amount: number) => {
        if (amount <= 0 || amount > vaultBalance) return;
        setVaultBalance(prev => prev - amount);
        if (isDemo) setDemoBalance(prev => prev + amount);
        addLog(`Vault Withdrawal: ${amount.toFixed(4)} SOL`);
    };

    const moveVaultToTrading = (amount: number) => {
        if (amount <= 0 || amount > vaultBalance) return;
        setVaultBalance(prev => prev - amount); setDemoBalance(prev => prev + amount);
        addLog(`Vault Transfer: ${amount.toFixed(4)} SOL`);
    };

    const toggleProfitProtection = () => setProfitProtectionEnabled(prev => !prev);
    const setProfitProtectionPercentage = (percent: number) => setProfitProtectionPercent(percent);
    const clearVault = () => { setVaultBalance(0); localStorage.removeItem('pump_vault_balance'); };

    return {
        activeTrades, tradeHistory, buyToken, sellToken, syncTrades, recoverTrades, clearTrades, updateTrade,
        logs, addLog, clearLogs, setDemoMode, demoBalance, stats, isCleaning, cleanupWaste,
        vaultBalance, profitProtectionEnabled, profitProtectionPercent, withdrawFromVault, moveVaultToTrading,
        toggleProfitProtection, setProfitProtectionPercentage, clearVault
    };
};
