import { useState, useEffect, useRef, useCallback } from 'react';
import { Connection, Keypair } from '@solana/web3.js';
import { toast } from 'sonner';
import { getTradeTransaction, signAndSendTransaction } from '../utils/pumpPortal';
import { getBalance, getTokenBalance, getPumpPrice, getTokenMetadata, getPumpData } from '../utils/solanaManager';

const SOL_FEE_RESERVE = 0.05; // Keep 0.05 SOL for fees (roughly 10-50 sell transactions)

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
                // Reset stats if they are insanely high (cleanup old paper data if user wants, but here we just load)
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
        localStorage.setItem('pump_trade_history', JSON.stringify(tradeHistory.slice(0, 100))); // Keep last 100
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

        // Find the trade in current state
        const trade = activeTrades.find(t => t.mint === mint);
        if (!trade) return;

        // Protection against concurrent sells or already closed trades
        if (trade.status === "selling" || trade.status === "closed") {
            return;
        }

        addLog(`Attempting to SELL ${amountPercent}% of ${trade.symbol}...`);

        try {
            if (isDemo) {
                const sellPrice = trade.currentPrice || 0;
                const costBasis = (trade.buyPrice || 0) * (trade.amountTokens || 0) * (amountPercent / 100);

                // If trade is STALE (>2m), assume price is dead (0) for stats to stay honest
                const isStale = trade.lastPriceUpdate && (Date.now() - trade.lastPriceUpdate > 120000);
                const effectiveSellPrice = isStale ? 0 : sellPrice;

                const rawRevenue = (trade.amountTokens || 0) * effectiveSellPrice * (amountPercent / 100);
                const revenue = rawRevenue * 0.97; // 3% friction
                const profit = revenue - costBasis;

                setDemoBalance(prev => prev + costBasis + profit);

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
                toast.success(`[DEMO] Sold ${amountPercent}% of ${trade.symbol}`);
                return;
            }

            if (!wallet) return;

            // REAL WALLET SELL LOGIC
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

            // Set status to "selling" to prevent parallel attempts
            setActiveTrades(prev => prev.map(t => t.mint === mint ? { ...t, status: "selling" } : t));

            // Scaled Priority Fee: 0.001 SOL base
            const priorityFee = tradeAmountPaid <= 0.05 ? 0.001 : Math.max(0.001, Math.min(0.003, tradeAmountPaid * 0.05));

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
                // Secondary check/retry with higher slippage
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

            // REAL-TIME ACCURATE PnL CALCULATION
            await new Promise(resolve => setTimeout(resolve, 2000)); // wait for index
            const balanceAfter = await getBalance(wallet.publicKey.toBase58(), connection);
            const revenue = balanceAfter - balanceBefore;
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

            if (amountPercent >= 99) {
                const closedTrade: ActiveTrade = {
                    ...trade,
                    status: "closed" as const,
                    currentPrice: trade.currentPrice,
                    pnlPercent: realizedPnlPercent, // Accurate percentage based on SOL delta
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

            // Revert status to OPEN if transaction just failed to land (prevent phantom losses)
            if (msg.includes("Account") || msg.includes("not found")) {
                // Real rug/loss
                setActiveTrades(prev => prev.filter(t => t.mint !== mint));
                setStats(prev => ({ ...prev, totalProfit: prev.totalProfit - (trade.amountSolPaid || 0), losses: prev.losses + 1 }));
            } else {
                // Temporary failure (slippage/gas), allow retry
                setActiveTrades(prev => prev.map(t => t.mint === mint ? { ...t, status: "open" } : t));
            }
        }
    }, [wallet, isDemo, activeTrades, connection, addLog, setDemoBalance, setStats, setActiveTrades, setTradeHistory, profitProtectionEnabled, profitProtectionPercent, setVaultBalance]);

    // WebSocket for Price Updates on Active Trades
    useEffect(() => {
        if (!wallet && !isDemo) return;

        const url = heliusKey
            ? `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}`
            : 'wss://pumpportal.fun/api/data';

        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
            if (heliusKey) {
                // Subscribe to trades via logs for tokens in active trades
                const mints = activeTrades.map(t => t.mint);
                if (mints.length > 0) {
                    const payload = {
                        jsonrpc: "2.0",
                        id: 1,
                        method: "logsSubscribe",
                        params: [
                            { mentions: mints },
                            { commitment: "processed" }
                        ]
                    };
                    ws.send(JSON.stringify(payload));
                }
            } else {
                // Resubscribe to existing trades if any
                const mints = activeTrades.map(t => t.mint);
                if (mints.length > 0) {
                    ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: mints }));
                }
            }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // Handle Helius log notifications for trades
                if (heliusKey && data.method === "logsNotification") {
                    const logs = data.params.result.value.logs as string[];
                    // In a real scenario, we'd parse the logs for bonding curve changes.
                    return;
                }

                if (data.mint && data.vSolInBondingCurve && data.vTokensInBondingCurve) {
                    // Standard PumpPortal price calculation: (vSol_SOL / vTokens) * 1M
                    // Convert vSol from lamports to SOL
                    const price = ((data.vSolInBondingCurve / 1000000000) / data.vTokensInBondingCurve) * 1000000;

                    setActiveTrades(prev => prev.map(trade => {
                        if (trade.mint === data.mint && trade.status === "open") {
                            // Ensure buyPrice is set (use current price if not set)
                            let buyPrice = trade.buyPrice;
                            if (buyPrice === 0 || buyPrice < 0.000000001) {
                                buyPrice = price;
                            }

                            const pnl = buyPrice > 0 ? ((price - buyPrice) / buyPrice) * 100 : 0;

                            // Track highest price for trailing stop
                            const highestPrice = trade.highestPrice ? Math.max(trade.highestPrice, price) : price;

                            return {
                                ...trade,
                                buyPrice, // Update buyPrice if it was invalid
                                currentPrice: price,
                                pnlPercent: pnl,
                                highestPrice,
                                lastPriceUpdate: Date.now(),
                                lastPriceChangeTime: price !== trade.currentPrice ? Date.now() : trade.lastPriceChangeTime
                            };
                        }
                        return trade;
                    }));
                }
            } catch (e) { }
        };

        return () => {
            ws.close();
        };
    }, [wallet, heliusKey, isDemo, activeTrades.length]); // Added activeTrades.length to resubscribe on new trades

    // Poll price for active trades - faster for first buyer mode and demo mode
    useEffect(() => {
        // Check if any trades are in first buyer mode (very short hold times)
        const hasFirstBuyerTrades = activeTrades.some(t =>
            t.status === "open" &&
            t.exitStrategy &&
            t.exitStrategy.maxHoldTime < 10
        );

        // DYNAMIC POLLING: Scale interval based on number of active trades to avoid RPC rate limits
        // Total requests per minute = (60 / pollInterval) * tradesToPoll
        const openTradesCount = activeTrades.filter(t => t.status === "open").length;

        let pollInterval = 1500; // Base interval
        if (hasFirstBuyerTrades || isDemo) {
            // Scale interval: 1s for 1 trade, 2s for 5 trades, up to 5s for 10+ trades
            pollInterval = Math.max(1000, Math.min(5000, 500 * openTradesCount));
        } else {
            // Even more conservative for real trading to preserve Helius credits
            pollInterval = Math.max(2000, Math.min(10000, 1000 * openTradesCount));
        }

        // Immediate price update on mount/change (don't wait for interval)
        const updatePrices = async () => {
            const openTrades = activeTrades.filter(t => t.status === "open");
            // For first buyer mode or demo mode, poll all trades more frequently
            const tradesToPoll = (hasFirstBuyerTrades || isDemo) ? openTrades : openTrades.slice(0, 10);
            if (tradesToPoll.length === 0) return;

            // PARALLEL EXECUTION: Fix for "hanging" app
            // Instead of awaiting each trade sequentially, we process them in parallel batches
            // This prevents UI blocking and increases trade reaction speed significantly
            const BATCH_SIZE = 5;
            const updates: Map<string, Partial<ActiveTrade>> = new Map();

            // Process trades in concurrent batches to avoid rate limits but stay fast
            for (let i = 0; i < tradesToPoll.length; i += BATCH_SIZE) {
                const batch = tradesToPoll.slice(i, i + BATCH_SIZE);

                await Promise.all(batch.map(async (trade) => {
                    try {
                        let price = 0;
                        let currentLiquidity = 0;

                        // DEMO MODE: Always use REAL prices from blockchain (even for demo trades)
                        if (trade.mint.startsWith('SIM') && !isDemo) {
                            // Simplify SIM logic for performance/reliability
                            const isRug = trade.symbol.includes("Garbage") || trade.symbol.includes("Rug");
                            const basePrice = trade.currentPrice > 0 ? trade.currentPrice : (trade.buyPrice > 0 ? trade.buyPrice : 0.000001);
                            // Random walk with drift
                            const change = 1 + (Math.random() * 0.1 - 0.05) + (isRug ? -0.01 : 0.005);
                            price = Math.max(0.000001, basePrice * change);
                        } else {
                            // REAL PRICE FETCHING (Parallelized)
                            try {
                                // Try to get full pump data (liquidity + price)
                                const pumpData = await getPumpData(trade.mint, connection);
                                if (pumpData) {
                                    currentLiquidity = pumpData.vSolInBondingCurve;
                                    if (pumpData.vTokensInBondingCurve > 0 && pumpData.vSolInBondingCurve > 0) {
                                        price = (pumpData.vSolInBondingCurve / pumpData.vTokensInBondingCurve) * 1000000;
                                    }
                                }

                                // Fallback if calculation failed
                                if (price === 0) {
                                    const fetchedPrice = await getPumpPrice(trade.mint, connection);
                                    if (fetchedPrice > 0) price = fetchedPrice;
                                }

                                // Paper Trading Realism: If RPC fails, keep price for 60s grace period.
                                // After 60s, assume token has rugged/stopped and set price to 0.
                                if (price === 0 && isDemo && trade.currentPrice > 0) {
                                    const timeSinceUpdate = Date.now() - (trade.lastPriceUpdate || Date.now());
                                    if (timeSinceUpdate > 60000) { // 60s grace period
                                        price = 0.000000001; // Effectively 0 to trigger Stop Loss
                                        if (timeSinceUpdate > 65000 && timeSinceUpdate < 75000) { // Log once
                                            addLog(`⚠️ RUG SIMULATION: No data for ${trade.symbol} for >60s. Marking as potential rug.`);
                                        }
                                    } else {
                                        price = trade.currentPrice;
                                    }
                                }
                            } catch (error) {
                                price = 0;
                            }
                        }

                        const priceToUse = price > 0 ? price : (trade.currentPrice > 0 ? trade.currentPrice : 0);

                        if (priceToUse > 0) {
                            // Calculate updates locally (don't set state yet)
                            let buyPrice = trade.buyPrice;
                            if (buyPrice === 0 || buyPrice < 0.000000001) {
                                buyPrice = priceToUse;
                            }

                            const pnl = buyPrice > 0 ? ((priceToUse - buyPrice) / buyPrice) * 100 : 0;
                            const highestPrice = trade.highestPrice ? Math.max(trade.highestPrice, priceToUse) : priceToUse;

                            // Check liquidity drain (Rug Pull Detector)
                            const prevLiq = (trade as any).lastLiquidity || 0;
                            if (prevLiq > 0 && trade.lastPriceUpdate) {
                                // Case A: Liquidity dropped >20% (partial rug)
                                if (currentLiquidity > 0 && prevLiq > 5 && (prevLiq - currentLiquidity) / prevLiq > 0.2) {
                                    updates.set(trade.mint, { status: "selling", lastLiquidity: currentLiquidity });
                                    sellToken(trade.mint, 100);
                                    addLog(`🚨 RUG PULL DETECTED: ${trade.symbol} liquidity dropped >20%. Selling!`);
                                    return;
                                }
                                // Case B: RPC returning null for previously active token (total rug/delist)
                                if (price <= 0.000000001 && Date.now() - trade.lastPriceUpdate > 45000) {
                                    updates.set(trade.mint, { status: "selling" });
                                    sellToken(trade.mint, 100);
                                    addLog(`🚨 TOTAL RUG DETECTED: ${trade.symbol} disappeared from blockchain. Exiting.`);
                                    return;
                                }
                            }

                            // Only update timestamp if we got a fresh price from network
                            const isFresh = price > 0;
                            const newLastPriceUpdate = isFresh ? Date.now() : (trade.lastPriceUpdate || Date.now());

                            // Auto-close if stale for > 3 minutes (180000ms)
                            // In Demo mode, we also auto-close to avoid "zombie" trades
                            if (!isFresh && Date.now() - newLastPriceUpdate > 180000) {
                                addLog(`⚠️ Token ${trade.symbol} stale >3m. Auto-closing as potential rug loss.`);
                                sellToken(trade.mint, 100);
                                const closedTrade = { ...trade, status: "closed" as const, currentPrice: 0, pnlPercent: -100 };
                                setTradeHistory(prev => [closedTrade, ...prev].slice(0, 100));
                                updates.set(trade.mint, { status: "closed" }); // This will be filtered in the map below
                                return;
                            }

                            // Prepare update object
                            const update: any = {
                                buyPrice,
                                currentPrice: priceToUse,
                                pnlPercent: pnl,
                                highestPrice,
                                lastPriceUpdate: newLastPriceUpdate,
                                lastPriceChangeTime: priceToUse !== trade.currentPrice ? Date.now() : trade.lastPriceChangeTime,
                                lastLiquidity: currentLiquidity > 0 ? currentLiquidity : (trade as any).lastLiquidity
                            };

                            updates.set(trade.mint, update);
                        }
                    } catch (e) {
                        // Ignore individual trade errors to keep the batch moving
                    }
                }));
            }

            // Apply ALL updates in ONE state change (Batching) to prevent re-renders
            if (updates.size > 0) {
                setActiveTrades(prev => prev.filter(t => {
                    const update = updates.get(t.mint);
                    return !update || update.status !== "closed";
                }).map(t => {
                    if (updates.has(t.mint)) {
                        const update = updates.get(t.mint);
                        return { ...t, ...update };
                    }
                    return t;
                }));
            }
        };

        // Run immediately on mount/change
        updatePrices();

        // Then run on interval
        const interval = setInterval(updatePrices, pollInterval);

        return () => clearInterval(interval);
    }, [activeTrades, connection, isDemo, addLog, sellToken]);

    // Subscribe when a new trade is added
    const subscribeToToken = (mint: string) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            if (heliusKey) {
                wsRef.current.send(JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "logsSubscribe",
                    params: [
                        { mentions: [mint] },
                        { commitment: "processed" }
                    ]
                }));
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

        addLog(`Initiating ${isDemo ? '[DEMO] ' : ''}BUY for ${symbol} (${amountSol} SOL)...`);

        if (isDemo) {
            if (demoBalance < amountSol) {
                addLog("[DEMO] Insufficient funds for trade.");
                return;
            }

            // Demo mode: Stop trading if balance gets too low (prevent burning through all demo SOL)
            if (demoBalance < amountSol * 2) {
                addLog("[DEMO] ⚠️ Low demo balance - stopping to prevent total loss. Reset demo balance to continue.");
                return;
            }

            setDemoBalance(prev => prev - amountSol);


            // DEMO MODE: Use REAL token prices from blockchain
            // If initialPrice is not provided, fetch it from the blockchain
            let buyPrice = initialPrice || 0;
            if (buyPrice === 0) {
                // Fetch real price from blockchain for demo trades
                try {
                    buyPrice = await getPumpPrice(mint, connection);
                    if (buyPrice === 0) {
                        // Try one more time with a small delay
                        await new Promise(resolve => setTimeout(resolve, 500));
                        buyPrice = await getPumpPrice(mint, connection);

                        if (buyPrice === 0) {
                            addLog(`[DEMO] ❌ Unable to fetch valid price for ${symbol}. Skipping trade.`);
                            setDemoBalance(prev => prev + amountSol); // Refund
                            return;
                        }
                    }
                } catch (e) {
                    addLog(`[DEMO] ❌ Error fetching price for ${symbol}. Skipping trade.`);
                    setDemoBalance(prev => prev + amountSol); // Refund
                    return;
                }
            }

            // Simulate 1.5% slippage/friction on entry price for paper trading realism
            buyPrice = buyPrice * 1.015;

            // Simulate 1% Pump.fun fee on entry (Realistic calculation)
            // Real trades pay 1% fee currently
            const effectiveSol = amountSol * 0.99;
            const amountTokens = buyPrice > 0 ? effectiveSol / buyPrice : effectiveSol;

            const newTrade: ActiveTrade = {
                mint,
                symbol,
                buyPrice,
                amountTokens,
                amountSolPaid: amountSol, // Track original investment
                currentPrice: buyPrice,
                pnlPercent: 0,
                status: "open",
                txId: `DEMO-${Date.now()}`, // Changed from SIM to DEMO to indicate demo trade
                buyTime: Date.now(),
                exitStrategy,
                originalAmount: amountSol
            };
            setActiveTrades(prev => [newTrade, ...prev]);
            subscribeToToken(mint);

            // CRITICAL: Immediately fetch real price to ensure buyPrice is accurate
            // This prevents issues where buyPrice is 0 or placeholder
            // Also fetch price immediately and then again after a short delay to ensure it's current
            setTimeout(async () => {
                try {
                    const realPrice = await getPumpPrice(mint, connection);
                    if (realPrice > 0) {
                        setActiveTrades(prev => prev.map(t => {
                            if (t.mint === mint && t.status === "open") {
                                const updatedBuyPrice = t.buyPrice === 0 || t.buyPrice < 0.000000001 ? realPrice : t.buyPrice;
                                const updatedPnl = updatedBuyPrice > 0 ? ((realPrice - updatedBuyPrice) / updatedBuyPrice) * 100 : 0;
                                addLog(`[DEMO] ${symbol} price update: buyPrice=${updatedBuyPrice.toFixed(9)}, current=${realPrice.toFixed(9)}, PnL=${updatedPnl.toFixed(2)}%`);
                                return {
                                    ...t,
                                    buyPrice: updatedBuyPrice,
                                    currentPrice: realPrice,
                                    pnlPercent: updatedPnl
                                };
                            }
                            return t;
                        }));
                    } else {
                        addLog(`[DEMO] ${symbol} price fetch returned 0 - will retry on next poll`);
                    }
                } catch (e: any) {
                    console.error(`[DEMO] Error fetching initial price for ${symbol}:`, e.message);
                    addLog(`[DEMO] ${symbol} price fetch error: ${e.message}`);
                }
            }, 1000); // 1 second delay to ensure trade is in state

            // Also fetch again after 3 seconds to ensure we have the latest price
            setTimeout(async () => {
                try {
                    const realPrice = await getPumpPrice(mint, connection);
                    if (realPrice > 0) {
                        setActiveTrades(prev => prev.map(t => {
                            if (t.mint === mint && t.status === "open" && (t.buyPrice === 0 || t.buyPrice < 0.000000001)) {
                                const updatedPnl = realPrice > 0 ? ((realPrice - realPrice) / realPrice) * 100 : 0;
                                addLog(`[DEMO] ${symbol} second price update: ${realPrice.toFixed(9)} SOL`);
                                return {
                                    ...t,
                                    buyPrice: realPrice,
                                    currentPrice: realPrice,
                                    pnlPercent: updatedPnl
                                };
                            }
                            return t;
                        }));
                    }
                } catch (e) {
                    // Silent fail on second attempt
                }
            }, 3000);

            addLog(`[DEMO] Paper trade placed for ${symbol} at ${buyPrice > 0.000001 ? buyPrice.toFixed(9) : 'market'} SOL (tracking real price)`);
            toast.success(`[DEMO] Bought ${symbol}`, { description: `Amount: ${amountSol} SOL` });
            return;
        }

        if (!wallet) return;

        // Internal dedupe check
        if (activeTrades.some(t => t.mint === mint)) {
            console.log("[buyToken] Already in activeTrades, skipping");
            return;
        }

        // Pre-trade balance check: Amount + Reserve (0.05)
        // This ensures the user never gets stuck with no SOL for sell fees
        try {
            const bal = await getBalance(wallet.publicKey.toBase58(), connection);
            if (bal < amountSol + SOL_FEE_RESERVE) {
                addLog(`Error: Insufficient balance. Have ${bal.toFixed(4)} SOL, need ~${(amountSol + SOL_FEE_RESERVE).toFixed(4)} SOL (incl. ${SOL_FEE_RESERVE} SOL reserve for fees)`);
                return;
            }
        } catch (e) { }

        try {
            // Lower priority fee for small trades: 0.001 SOL or 2% of trade, whichever is smaller.
            const priorityFee = amountSol <= 0.05 ? 0.001 : Math.max(0.001, Math.min(0.005, amountSol * 0.1));

            const transactionBuffer = await getTradeTransaction({
                publicKey: wallet.publicKey.toBase58(),
                action: "buy",
                mint,
                amount: amountSol,
                denominatedInSol: "true",
                slippage,
                priorityFee,
                pool: "pump"
            });

            const signature = await signAndSendTransaction(connection, transactionBuffer, wallet);
            addLog(`Buy Tx Sent: ${signature.substring(0, 8)}...`);

            const newTrade: ActiveTrade = {
                mint,
                symbol,
                buyPrice: initialPrice || 0,
                amountTokens: 0,
                amountSolPaid: amountSol,
                currentPrice: initialPrice || 0,
                pnlPercent: 0,
                status: "open",
                txId: signature,
                lastPriceChangeTime: Date.now(),
                buyTime: Date.now(),
                exitStrategy,
                originalAmount: amountSol
            };

            setActiveTrades(prev => [newTrade, ...prev]);
            subscribeToToken(mint);

            // Wait for confirmation to be sure
            connection.confirmTransaction(signature, 'confirmed').then(async (res) => {
                if (!res.value.err) {
                    addLog(`✅ Buy Confirmed for ${symbol}! Fetching on-chain costs...`);

                    // CRITICAL FIX: Fetch actual token balance to calculate REAL entry price
                    try {
                        // Small delay to ensure balance is indexed
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        const actualTokens = await getTokenBalance(wallet.publicKey.toBase58(), mint, connection);

                        if (actualTokens > 0) {
                            const realBuyPrice = amountSol / actualTokens;
                            addLog(`📊 On-chain Entry Price: ${realBuyPrice.toFixed(9)} SOL (Tokens: ${actualTokens.toLocaleString()})`);

                            setActiveTrades(prev => prev.map(t => t.mint === mint ? {
                                ...t,
                                buyPrice: realBuyPrice,
                                amountTokens: actualTokens,
                                isPaper: false
                            } : t));
                        } else {
                            // Fallback if balance fetch fails
                            setActiveTrades(prev => prev.map(t => t.mint === mint ? { ...t, isPaper: false } : t));
                        }
                    } catch (e) {
                        setActiveTrades(prev => prev.map(t => t.mint === mint ? { ...t, isPaper: false } : t));
                    }
                } else {
                    addLog(`❌ Buy Failed on-chain for ${symbol}. Removing from internal tracker.`);
                    setActiveTrades(prev => prev.filter(t => t.mint !== mint));
                }
                syncTrades();
            }).catch((e) => {
                addLog(`⚠️ Buy Confirmation Timeout for ${symbol}. Bot will sync balance automatically.`);
                // Keep it in activeTrades, syncTrades will verify balance shortly
                setTimeout(() => syncTrades(), 5000);
            });
        } catch (error: any) {
            let errorMsg = error.message || "Unknown error";

            if (errorMsg.includes("0x1772") || errorMsg.includes("TooMuchSolRequired")) {
                errorMsg = "Slippage error: Price moved too fast. Try higher slippage.";
            } else if (errorMsg.includes("0x1") || errorMsg.includes("Insufficient lamports")) {
                errorMsg = "Balance error: Insufficient SOL for trade + fees.";
            } else if (errorMsg.includes("Simulation failed")) {
                errorMsg = "Trade Simulation Failed (Price might have moved too fast)";
            }

            addLog(`Buy Failed: ${errorMsg}`);
            toast.error(`Buy Failed: ${symbol}`, { description: errorMsg });
        }
    };

    const syncTrades = async () => {
        if (isDemo || !wallet) return;
        addLog("Syncing portfolio with blockchain...");

        const openTrades = activeTrades.filter(t => t.status === "open");
        for (const trade of openTrades) {
            try {
                const bal = await getTokenBalance(wallet.publicKey.toBase58(), trade.mint, connection);
                if (bal > 0) {
                    setActiveTrades(prev => prev.map(t => t.mint === trade.mint ? { ...t, amountTokens: bal } : t));
                    addLog(`Synced: Verified ${bal.toFixed(2)} tokens for ${trade.symbol}.`);
                } else {
                    // Only close if it's been at least 1 minute and balance is still 0
                    const age = Date.now() - (trade.lastPriceChangeTime || 0);
                    if (age > 60000) {
                        const closedTrade = {
                            ...trade,
                            status: "closed" as const,
                            currentPrice: 0,
                            pnlPercent: -100
                        };
                        setTradeHistory(prev => [closedTrade, ...prev].slice(0, 100));
                        setActiveTrades(prev => prev.filter(t => t.mint !== trade.mint));

                        const lossAmount = trade.amountSolPaid || 0;
                        setStats(prev => ({
                            ...prev,
                            totalProfit: prev.totalProfit - lossAmount,
                            losses: prev.losses + 1
                        }));
                        addLog(`Synced: ${trade.symbol} has 0 balance after 60s. Marking as RUG loss (-${lossAmount.toFixed(4)} SOL).`);
                    } else {
                        addLog(`Synced: ${trade.symbol} balance not found yet, retrying later...`);
                    }
                }
            } catch (e) {
                console.error("Sync error for", trade.symbol, e);
            }
        }
    };

    const recoverTrades = async () => {
        if (isDemo || !wallet) return;
        addLog("Scanning wallet for existing tokens...");
        try {
            const { PublicKey } = await import('@solana/web3.js');
            const userPub = wallet.publicKey;
            const accounts = await connection.getParsedTokenAccountsByOwner(userPub, {
                programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
            });

            for (const acc of accounts.value) {
                const info = acc.account.data.parsed.info;
                const mint = info.mint;
                const balance = info.tokenAmount.uiAmount;

                if (balance > 0 && !activeTrades.some(t => t.mint === mint)) {
                    // It's a token we have but aren't tracking. Check if it's a pump token.
                    if (mint.endsWith('pump')) {
                        addLog(`Found untracked token: ${mint.substring(0, 6)}...`);
                        const meta = await getTokenMetadata(mint, heliusKey);
                        const price = await getPumpPrice(mint, connection);

                        const recoveredTrade: ActiveTrade = {
                            mint,
                            symbol: meta.symbol,
                            buyPrice: price,
                            amountTokens: balance,
                            amountSolPaid: balance * price, // Estimate cost basis so PnL isn't 0
                            originalAmount: balance * price,
                            currentPrice: price,
                            pnlPercent: 0,
                            status: "open",
                            lastPriceChangeTime: Date.now()
                        };
                        setActiveTrades(prev => [recoveredTrade, ...prev]);
                    }
                }
            }
            addLog("Wallet scan complete.");
        } catch (e: any) {
            addLog(`Scan Error: ${e.message}`);
        }
    };

    const clearTrades = () => {
        setActiveTrades([]);
        setTradeHistory([]);
        setStats({ totalProfit: 0, wins: 0, losses: 0 });
        localStorage.removeItem('pump_active_trades');
        localStorage.removeItem('pump_trade_history');
        localStorage.removeItem('pump_stats');
        addLog("Summary: Portfolio, Trade History and Total PnL statistics have been reset.");
    };

    // Helper to update a trade's properties (for staged profit taking, etc.)
    const updateTrade = (mint: string, updates: Partial<ActiveTrade>) => {
        setActiveTrades(prev => prev.map(t =>
            t.mint === mint ? { ...t, ...updates } : t
        ));
    };

    // Vault Management Functions
    const withdrawFromVault = (amount: number) => {
        if (amount <= 0 || amount > vaultBalance) {
            addLog(`❌ Invalid withdrawal amount. Vault has ${vaultBalance.toFixed(4)} SOL`);
            return;
        }
        setVaultBalance(prev => {
            const newVal = Math.max(0, prev - amount);
            localStorage.setItem('pump_vault_balance', newVal.toString());
            return newVal;
        });
        if (isDemo) {
            setDemoBalance(prev => prev + amount);
            addLog(`💰 Withdrew ${amount.toFixed(4)} SOL from vault to PAPER balance`);
        } else {
            // REAL Withdrawal log
            addLog(`💰 Released ${amount.toFixed(4)} SOL from vault protection back to available balance.`);
            addLog(`ℹ️ Note: Vault funds stay in your wallet for safety. This just updates the bot's tradeable limit.`);
        }
    };

    const moveVaultToTrading = (amount: number) => {
        if (amount <= 0 || amount > vaultBalance) {
            addLog(`❌ Invalid transfer amount. Vault has ${vaultBalance.toFixed(4)} SOL`);
            return;
        }
        setVaultBalance(prev => prev - amount);
        setDemoBalance(prev => prev + amount);
        addLog(`📊 Moved ${amount.toFixed(4)} SOL from vault to trading balance`);
    };

    const toggleProfitProtection = () => {
        setProfitProtectionEnabled(prev => !prev);
        addLog(`🔒 Profit Protection ${!profitProtectionEnabled ? 'ENABLED' : 'DISABLED'}`);
    };

    const setProfitProtectionPercentage = (percent: number) => {
        if (percent < 0 || percent > 50) {
            addLog(`❌ Protection percentage must be between 0-50%`);
            return;
        }
        setProfitProtectionPercent(percent);
        addLog(`🔒 Profit Protection set to ${percent}%`);
    };

    const clearVault = () => {
        setVaultBalance(0);
        localStorage.removeItem('pump_vault_balance');
        addLog("🔒 Profit Protection Vault wiped clean.");
    };

    return {
        activeTrades,
        tradeHistory,
        buyToken,
        sellToken,
        syncTrades,
        recoverTrades,
        clearTrades,
        updateTrade,
        logs,
        addLog,
        clearLogs,
        setDemoMode,
        demoBalance,
        stats,
        // Vault
        vaultBalance,
        profitProtectionEnabled,
        profitProtectionPercent,
        withdrawFromVault,
        moveVaultToTrading,
        toggleProfitProtection,
        setProfitProtectionPercentage,
        clearVault
    };
};
// Trigger Build: 01/22/2026 14:39:21
