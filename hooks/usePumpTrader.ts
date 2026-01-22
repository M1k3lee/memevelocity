import { useState, useEffect, useRef, useCallback } from 'react';
import { Connection, Keypair } from '@solana/web3.js';
import { toast } from 'sonner';
import { getTradeTransaction, signAndSendTransaction } from '../utils/pumpPortal';
import { getBalance, getTokenBalance, getPumpPrice, getTokenMetadata, getPumpData } from '../utils/solanaManager';

const SOL_FEE_RESERVE = 0.02; // Reduced from 0.05 to allow small balance trading

export interface ActiveTrade {
    mint: string;
    symbol: string;
    buyPrice: number; // SOL per token
    amountTokens: number; // Token balance
    amountSolPaid?: number; // Original SOL used
    currentPrice: number;
    pnlPercent: number;
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

export const usePumpTrader = (wallet: Keypair | null, connection: Connection, heliusKey?: string) => {
    const [activeTrades, setActiveTrades] = useState<ActiveTrade[]>([]);
    const [tradeHistory, setTradeHistory] = useState<ActiveTrade[]>([]);
    const [logs, setLogs] = useState<string[]>([]);
    const [isDemo, setIsDemo] = useState(false);
    const [demoBalance, setDemoBalance] = useState(10.0);
    const [stats, setStats] = useState({ totalProfit: 0, wins: 0, losses: 0 });
    const [isCleaning, setIsCleaning] = useState(false);
    const processingMintsRef = useRef<Set<string>>(new Set());

    // Profit Protection Vault
    const [vaultBalance, setVaultBalance] = useState(0);
    const [profitProtectionEnabled, setProfitProtectionEnabled] = useState(true);
    const [profitProtectionPercent, setProfitProtectionPercent] = useState(25);

    const wsRef = useRef<WebSocket | null>(null);

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

    // Define sellToken early so it can be used in useEffect
    const sellToken = useCallback(async (mint: string, amountPercent: number = 100) => {
        if (!wallet && !isDemo) return;
        if (processingMintsRef.current.has(mint)) return;

        const trade = activeTrades.find(t => t.mint === mint);
        if (!trade || trade.status === "closed" || trade.status === "selling") return;

        processingMintsRef.current.add(mint);
        addLog(`Attempting to SELL ${amountPercent}% of ${trade.symbol}...`);

        try {
            if (isDemo) {
                const sellPrice = trade.currentPrice || 0;
                const costBasis = (trade.buyPrice || 0) * (trade.amountTokens || 0) * (amountPercent / 100);

                const isStale = trade.lastPriceUpdate && (Date.now() - trade.lastPriceUpdate > 120000);
                const effectiveSellPrice = isStale ? 0 : sellPrice;

                const rawRevenue = (trade.amountTokens || 0) * effectiveSellPrice * (amountPercent / 100);
                const revenue = rawRevenue * 0.97; // 3% friction
                const profit = revenue - costBasis;

                const rentReclaim = amountPercent >= 99 ? 0.00204 : 0;
                setDemoBalance(prev => prev + costBasis + profit + rentReclaim);

                setStats(prev => ({
                    totalProfit: prev.totalProfit + profit,
                    wins: profit > 0 ? prev.wins + 1 : prev.wins,
                    losses: profit <= 0 ? prev.losses + 1 : prev.losses
                }));

                const closedTrade: ActiveTrade = {
                    ...trade,
                    status: "closed" as const,
                    currentPrice: effectiveSellPrice,
                    pnlPercent: trade.buyPrice > 0 ? ((effectiveSellPrice - trade.buyPrice) / trade.buyPrice) * 100 : 0,
                    isPaper: true
                };

                if (amountPercent >= 99) {
                    setTradeHistory(prev => {
                        if (prev.some(t => t.mint === mint && Math.abs((t.buyTime || 0) - (trade.buyTime || 0)) < 1000)) return prev;
                        return [closedTrade, ...prev].slice(0, 100);
                    });
                    setActiveTrades(prev => prev.filter(t => t.mint !== mint));
                }

                addLog(`[DEMO] Sold ${amountPercent}% at ${sellPrice.toFixed(9)} SOL. Profit: ${profit.toFixed(4)} SOL`);
                processingMintsRef.current.delete(mint);
                return;
            }

            if (!wallet) return;

            const balance = await getTokenBalance(wallet.publicKey.toBase58(), mint, connection);
            if (balance === 0) {
                if (Date.now() - (trade.lastPriceChangeTime || 0) > 60000) {
                    addLog(`Sell: No balance for ${trade.symbol}. Closing as RUG loss.`);
                    const closedTrade: ActiveTrade = { ...trade, status: "closed" as const, currentPrice: 0, pnlPercent: -100 };
                    setTradeHistory(prev => [closedTrade, ...prev].slice(0, 100));
                    setActiveTrades(prev => prev.filter(t => t.mint !== mint));

                    const lossAmount = trade.amountSolPaid || 0;
                    setStats(prev => ({ ...prev, totalProfit: prev.totalProfit - lossAmount, losses: prev.losses + 1 }));
                }
                return;
            }

            const amountToSell = balance * (amountPercent / 100);
            const tradeAmountPaid = trade.amountSolPaid || 0.03;

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
                    pool: "pump"
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
                    pool: "pump"
                });
            }

            const balanceBefore = await getBalance(wallet.publicKey.toBase58(), connection);
            const signature = await signAndSendTransaction(connection, transactionBuffer, wallet);
            addLog(`Sell Tx Sent: ${signature.substring(0, 8)}...`);

            const confirmation = await connection.confirmTransaction(signature, 'confirmed');
            if (confirmation.value.err) throw new Error("On-chain execution failed");

            await new Promise(resolve => setTimeout(resolve, 2000));
            const balanceAfter = await getBalance(wallet.publicKey.toBase58(), connection);
            const revenue = (balanceAfter ?? 0) - (balanceBefore ?? 0);
            const costBasis = tradeAmountPaid * (amountPercent / 100);
            const netProfit = revenue - costBasis;
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
                    ...trade,
                    status: "closed" as const,
                    currentPrice: trade.currentPrice,
                    pnlPercent: finalPnlPercent,
                    txId: signature
                };
                setTradeHistory(prev => {
                    if (prev.some(t => t.mint === mint && Math.abs((t.buyTime || 0) - (trade.buyTime || 0)) < 1000)) return prev;
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
            toast.success(`Sold ${trade.symbol}! PnL: ${netProfit.toFixed(4)} SOL`);

        } catch (error: any) {
            const msg = error.message || "Execution error";
            addLog(`❌ Sell Failed for ${trade.symbol}: ${msg}`);
            if (msg.includes("Account") || msg.includes("not found")) {
                setActiveTrades(prev => prev.filter(t => t.mint !== mint));
                const lossAmount = trade.amountSolPaid || 0;
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
    }, [wallet, isDemo, activeTrades, connection, addLog, setDemoBalance, setStats, setActiveTrades, setTradeHistory, profitProtectionEnabled, profitProtectionPercent, setVaultBalance]);

    // --- PRICE CALCULATION ENGINE ---

    const updatePrices = useCallback(async () => {
        const openTrades = activeTrades.filter(t => t.status === "open");
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

                    if (trade.mint.startsWith('SIM') && !isDemo) {
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
                                    price = (pumpData.vSolInBondingCurve / pumpData.vTokensInBondingCurve) * 1000000;
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
                        if (buyPrice === 0 || buyPrice < 0.000000001) buyPrice = priceToUse;

                        const pnl = buyPrice > 0 ? ((priceToUse - buyPrice) / buyPrice) * 100 : 0;
                        const highestPrice = trade.highestPrice ? Math.max(trade.highestPrice, priceToUse) : priceToUse;

                        const prevLiq = trade.lastLiquidity || 0;
                        if (prevLiq > 0 && trade.lastPriceUpdate) {
                            if (currentLiquidity > 0 && prevLiq > 5 && (prevLiq - currentLiquidity) / prevLiq > 0.2) {
                                updates.set(trade.mint, { status: "selling", lastLiquidity: currentLiquidity });
                                sellToken(trade.mint, 100);
                                addLog(`🚨 RUG PULL DETECTED: ${trade.symbol} liquidity dropped >20%. Selling!`);
                                return;
                            }
                        }

                        updates.set(trade.mint, {
                            buyPrice,
                            currentPrice: priceToUse,
                            pnlPercent: pnl,
                            highestPrice,
                            lastPriceUpdate: Date.now(),
                            lastPriceChangeTime: priceToUse !== trade.currentPrice ? Date.now() : trade.lastPriceChangeTime,
                            lastLiquidity: currentLiquidity > 0 ? currentLiquidity : trade.lastLiquidity
                        });
                    }
                } catch (e) { }
            }));
        }

        if (updates.size > 0) {
            setActiveTrades(prev => prev.map(t => updates.has(t.mint) ? { ...t, ...updates.get(t.mint) } : t));
        }
    }, [activeTrades, connection, isDemo, addLog, sellToken]);

    // WebSocket Hook
    useEffect(() => {
        if (!wallet && !isDemo) return;
        const url = heliusKey ? `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}` : 'wss://pumpportal.fun/api/data';
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
            const mints = activeTrades.filter(t => t.status === "open").map(t => t.mint);
            if (mints.length > 0) {
                if (heliusKey) {
                    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: mints }, { commitment: "processed" }] }));
                } else {
                    ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: mints }));
                }
            }
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if ((heliusKey && data.method === "logsNotification") || (data.mint && (data.vSolInBondingCurve || data.price))) {
                updatePrices();
            }
        };

        return () => ws.close();
    }, [wallet, heliusKey, isDemo, activeTrades.length, updatePrices]);

    // Polling Hook (2s Heartbeat)
    useEffect(() => {
        const interval = setInterval(updatePrices, 2000);
        return () => clearInterval(interval);
    }, [updatePrices]);

    const subscribeToToken = (mint: string) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            if (heliusKey) {
                wsRef.current.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [mint] }, { commitment: "processed" }] }));
            } else {
                wsRef.current.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
            }
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
                txId: `DEMO-${Date.now()}`, buyTime: Date.now(), exitStrategy, originalAmount: amountSol
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
            const bal = await getBalance(wallet.publicKey.toBase58(), connection);
            if (bal === null || bal < amountSol + SOL_FEE_RESERVE) {
                addLog(`Error: Insufficient balance. Need ${amountSol + SOL_FEE_RESERVE} SOL.`);
                return;
            }

            const priorityFee = amountSol <= 0.05 ? 0.0003 : Math.max(0.001, Math.min(0.003, amountSol * 0.05));
            const transactionBuffer = await getTradeTransaction({
                publicKey: wallet.publicKey.toBase58(),
                action: "buy", mint, amount: amountSol, denominatedInSol: "true",
                slippage, priorityFee, pool: "pump"
            });

            const signature = await signAndSendTransaction(connection, transactionBuffer, wallet);
            addLog(`Buy Tx Sent: ${signature.substring(0, 8)}...`);

            const newTrade: ActiveTrade = {
                mint, symbol, buyPrice: initialPrice || 0, amountTokens: 0, amountSolPaid: amountSol,
                currentPrice: initialPrice || 0, pnlPercent: 0, status: "open", txId: signature,
                buyTime: Date.now(), exitStrategy, originalAmount: amountSol
            };

            setActiveTrades(prev => [newTrade, ...prev]);
            subscribeToToken(mint);

            connection.confirmTransaction(signature, 'confirmed').then(async (res) => {
                if (!res.value.err) {
                    await new Promise(r => setTimeout(r, 2000));
                    const actualTokens = await getTokenBalance(wallet.publicKey.toBase58(), mint, connection);
                    if (actualTokens > 0) {
                        setActiveTrades(prev => prev.map(t => t.mint === mint ? { ...t, buyPrice: amountSol / actualTokens, amountTokens: actualTokens } : t));
                    }
                } else {
                    setActiveTrades(prev => prev.filter(t => t.mint !== mint));
                }
                syncTrades();
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
        for (const trade of activeTrades.filter(t => t.status === "open")) {
            try {
                const bal = await getTokenBalance(wallet.publicKey.toBase58(), trade.mint, connection);
                if (bal > 0) {
                    setActiveTrades(prev => prev.map(t => t.mint === trade.mint ? { ...t, amountTokens: bal } : t));
                } else if (Date.now() - (trade.buyTime || 0) > 60000) {
                    setActiveTrades(prev => prev.filter(t => t.mint !== trade.mint));
                }
            } catch (e) { }
        }
    };

    const cleanupWaste = async () => {
        if (!wallet || isDemo) return;
        setIsCleaning(true);
        addLog("🧹 Cleanup in progress...");
        try {
            const { Transaction } = await import('@solana/web3.js');
            const { TOKEN_PROGRAM_ID, createCloseAccountInstruction } = await import('@solana/spl-token');
            const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
            const toClose = accounts.value.filter(acc => acc.account.data.parsed.info.tokenAmount.uiAmount <= 0 && !activeTrades.some(t => t.mint === acc.account.data.parsed.info.mint)).slice(0, 20);
            if (toClose.length === 0) { setIsCleaning(false); return; }
            const transaction = new Transaction();
            toClose.forEach(acc => transaction.add(createCloseAccountInstruction(acc.pubkey, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID)));
            const { blockhash } = await connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = wallet.publicKey;
            transaction.sign(wallet);
            const sig = await connection.sendRawTransaction(transaction.serialize());
            addLog(`Cleanup Tx Sent: ${sig.substring(0, 8)}...`);
            await connection.confirmTransaction(sig);
            addLog(`✅ Rescued ${(toClose.length * 0.00204).toFixed(4)} SOL`);
        } catch (e: any) { addLog(`Cleanup Failed: ${e.message}`); } finally { setIsCleaning(false); }
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
