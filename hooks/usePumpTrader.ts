import { useState, useEffect, useRef, useCallback } from 'react';
import { Connection, Keypair } from '@solana/web3.js';
import { toast } from 'sonner';
import { getTradeTransaction, signAndSendTransaction } from '../utils/pumpPortal';
import { getBalance, getTokenBalance, getPumpPrice, getTokenMetadata, getPumpData } from '../utils/solanaManager';

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
}

export const usePumpTrader = (wallet: Keypair | null, connection: Connection, heliusKey?: string) => {
    const [activeTrades, setActiveTrades] = useState<ActiveTrade[]>([]);
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
        const savedLogs = localStorage.getItem('pump_logs');
        if (savedLogs) {
            try { setLogs(JSON.parse(savedLogs)); } catch (e) { }
        }
        const savedStats = localStorage.getItem('pump_stats');
        if (savedStats) {
            try { setStats(JSON.parse(savedStats)); } catch (e) { }
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
        const trade = activeTrades.find(t => t.mint === mint);
        if (!trade) return;

        addLog(`Attempting to SELL ${amountPercent}% of ${trade.symbol}...`);

        try {
            if (isDemo) {
                const sellPrice = trade.currentPrice || 0;
                const costBasis = trade.buyPrice * trade.amountTokens * (amountPercent / 100);

                // If trade is STALE (>2m), assume price is dead (0) for stats to stay honest
                const isStale = trade.lastPriceUpdate && (Date.now() - trade.lastPriceUpdate > 120000);
                const effectiveSellPrice = isStale ? 0 : sellPrice;

                const rawRevenue = trade.amountTokens * effectiveSellPrice * (amountPercent / 100);
                const revenue = rawRevenue * 0.985;
                const profit = revenue - costBasis;

                // Profit Protection: Skim percentage of profit to vault
                let profitToVault = 0;
                let profitToTrading = profit;

                if (profitProtectionEnabled && profit > 0) {
                    profitToVault = profit * (profitProtectionPercent / 100);
                    profitToTrading = profit - profitToVault;
                    setVaultBalance(prev => prev + profitToVault);
                    addLog(`🔒 Protected ${profitToVault.toFixed(4)} SOL (${profitProtectionPercent}%) to vault`);
                }

                // Add principal + remaining profit to trading balance
                setDemoBalance(prev => prev + costBasis + profitToTrading);

                setStats(prev => ({
                    totalProfit: prev.totalProfit + profit,
                    wins: profit > 0 ? prev.wins + 1 : prev.wins,
                    losses: profit <= 0 ? prev.losses + 1 : prev.losses
                }));

                setActiveTrades(prev => prev.map(t => {
                    if (t.mint === mint) {
                        const isFullSell = amountPercent >= 99;
                        const remainingTokens = isFullSell ? 0 : t.amountTokens * (1 - amountPercent / 100);
                        const remainingSolPaid = isFullSell ? 0 : (t.amountSolPaid || 0) * (1 - amountPercent / 100);

                        return {
                            ...t,
                            status: isFullSell ? "closed" : "open",
                            amountTokens: remainingTokens,
                            amountSolPaid: remainingSolPaid,
                            currentPrice: effectiveSellPrice,
                            pnlPercent: t.buyPrice > 0 ? ((effectiveSellPrice - t.buyPrice) / t.buyPrice) * 100 : 0
                        };
                    }
                    return t;
                }));
                addLog(`[DEMO] Sold ${amountPercent}% at ${sellPrice.toFixed(9)} SOL. Rev: ${revenue.toFixed(4)} SOL, Profit: ${profit > 0 ? '+' : ''}${profit.toFixed(4)} SOL`);
                toast.success(`[DEMO] Sold ${amountPercent}% of ${trade.symbol}`, { description: `Profit: ${profit > 0 ? '+' : ''}${profit.toFixed(4)} SOL` });
                return;
            }

            if (!wallet) return;

            // Ensure we have current balance
            const balance = await getTokenBalance(wallet.publicKey.toBase58(), mint, connection);

            if (balance === 0) {
                // If balance is 0 but we thought we had tokens, maybe we already sold?
                // Check if trade is old (>1 min) - if so, just close it locally
                if (Date.now() - (trade.lastPriceChangeTime || 0) > 60000) {
                    addLog(`Sell Failed: No balance for ${trade.symbol}. Assuming sold external/rug. Closing as loss.`);
                    setActiveTrades(prev => prev.map(t => t.mint === mint ? {
                        ...t,
                        status: "closed",
                        currentPrice: 0,
                        pnlPercent: -100
                    } : t));
                } else {
                    addLog(`Sell Failed: No balance found for ${trade.symbol} (yet)`);
                }
                return;
            }

            const amountToSell = balance * (amountPercent / 100);

            // Set status to "selling" locally to indicate progress if not already set (e.g. by rug detector)
            setActiveTrades(prev => prev.map(t => t.mint === mint ? { ...t, status: "selling" } : t));

            // Skip dust sells if not 100%
            if (amountPercent < 100 && (amountToSell * trade.currentPrice) < 0.001) {
                addLog(`Skipped dust sell for ${trade.symbol} (Value too low)`);
                setActiveTrades(prev => prev.map(t => t.mint === mint ? { ...t, status: "open" } : t));
                return;
            }

            const priorityFee = Math.max(0.001, Math.min(0.005, (trade.amountSolPaid || 0.1) * 0.1));

            // Retry logic for transaction building
            let transactionBuffer;
            try {
                transactionBuffer = await getTradeTransaction({
                    publicKey: wallet.publicKey.toBase58(),
                    action: "sell",
                    mint,
                    amount: amountToSell, // Sell actual token amount, not SOL value
                    denominatedInSol: "false",
                    slippage: 20, // Increased slippage for sells to ensure exit
                    priorityFee,
                    pool: "pump"
                });
            } catch (err: any) {
                // Retry once with higher slippage if failed
                console.warn("Sell tx build failed, retrying with higher slippage...");
                transactionBuffer = await getTradeTransaction({
                    publicKey: wallet.publicKey.toBase58(),
                    action: "sell",
                    mint,
                    amount: amountToSell,
                    denominatedInSol: "false",
                    slippage: 50, // High slippage to force exit
                    priorityFee: 0.005, // High priority fee
                    pool: "pump"
                });
            }

            const signature = await signAndSendTransaction(connection, transactionBuffer, wallet);
            addLog(`Sell Tx Sent: ${signature.substring(0, 8)}...`);

            // Real Trade Stats Update
            const sellPrice = trade.currentPrice || 0;
            // Realistic SOL received estimate (1% fee + 1% avg slippage/priority = ~2% friction)
            const estimatedSolReceived = amountToSell * sellPrice * 0.98;
            const estimatedCostBasis = (trade.buyPrice || sellPrice) * (trade.amountTokens * (amountPercent / 100));
            const estimatedProfit = estimatedSolReceived - estimatedCostBasis;

            // Profit Protection: Skim percentage of profit to vault for real trades too
            if (profitProtectionEnabled && estimatedProfit > 0) {
                const profitToVault = estimatedProfit * (profitProtectionPercent / 100);
                setVaultBalance(prev => prev + profitToVault);
                addLog(`🔒 Protected ${profitToVault.toFixed(4)} SOL (${profitProtectionPercent}%) from REAL trade to vault`);
            }

            setStats(prev => ({
                totalProfit: prev.totalProfit + estimatedProfit,
                wins: estimatedProfit > 0 ? prev.wins + 1 : prev.wins,
                losses: estimatedProfit <= 0 ? prev.losses + 1 : prev.losses
            }));

            // Only close trade locally if 100% sell
            if (amountPercent >= 99) {
                setActiveTrades(prev => prev.map(t => {
                    if (t.mint === mint) {
                        return {
                            ...t,
                            status: "closed",
                            currentPrice: sellPrice,
                            pnlPercent: t.buyPrice > 0 ? ((sellPrice - t.buyPrice) / t.buyPrice) * 100 : 0
                        };
                    }
                    return t;
                }));
            } else {
                // If partial sell, put back to open and update local amounts so UI reflects remaining position immediately
                setActiveTrades(prev => prev.map(t => {
                    if (t.mint === mint) {
                        const remainingTokens = t.amountTokens * (1 - amountPercent / 100);
                        const remainingSolPaid = (t.amountSolPaid || 0) * (1 - amountPercent / 100);
                        return {
                            ...t,
                            status: "open",
                            amountTokens: remainingTokens,
                            amountSolPaid: remainingSolPaid
                        };
                    }
                    return t;
                }));
            }
        } catch (error: any) {
            addLog(`Sell Error: ${error.message}`);
            // If error is "Account not found" or similar, it means we don't have the token
            if (error.message?.includes("Account") || error.message?.includes("not found") || error.message?.includes("0.00 SOL")) {
                setActiveTrades(prev => prev.map(t => t.mint === mint ? { ...t, status: "closed" } : t));
            } else {
                // Otherwise, put it back to open so the bot/user can try again
                setActiveTrades(prev => prev.map(t => t.mint === mint && t.status === "selling" ? { ...t, status: "open" } : t));
            }
        }
    }, [wallet, isDemo, activeTrades, connection, addLog, setDemoBalance, setStats, setActiveTrades, profitProtectionEnabled, profitProtectionPercent, setVaultBalance]);

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
                    // Standard PumpPortal price calculation: (vSol / vTokens) * 1M
                    const price = (data.vSolInBondingCurve / data.vTokensInBondingCurve) * 1000000;

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

        // Use faster polling for demo mode (paper trading) and first buyer mode
        // Demo mode needs fast updates to catch quick price movements
        // FIX: Reduced interval from 12000ms to 1000ms to catch "quick x3/x5" pumps
        const pollInterval = hasFirstBuyerTrades ? 1000 : (isDemo ? 1000 : 1500);

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

                                // If RPC fails, keep old price in demo mode to prevent bad exits
                                if (price === 0 && isDemo && trade.currentPrice > 0) {
                                    price = trade.currentPrice;
                                }
                            } catch (error) {
                                // Silent fail, keep old price
                                if (isDemo && trade.currentPrice > 0) price = trade.currentPrice;
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
                            if (currentLiquidity > 0 && trade.lastPriceUpdate) {
                                const prevLiq = (trade as any).lastLiquidity || currentLiquidity;
                                // >20% drop is a rug
                                if (prevLiq > 5 && (prevLiq - currentLiquidity) / prevLiq > 0.2) {
                                    // Rug pull detected - exit immediately
                                    updates.set(trade.mint, { status: "selling", lastLiquidity: currentLiquidity });
                                    sellToken(trade.mint, 100);
                                    addLog(`🚨 RUG PULL DETECTED: ${trade.symbol} liquidity dropped >20%. Selling!`);
                                    return;
                                }
                            }

                            // Only update timestamp if we got a fresh price from network
                            const isFresh = price > 0;
                            const newLastPriceUpdate = isFresh ? Date.now() : (trade.lastPriceUpdate || Date.now());

                            // Auto-close if stale for > 5 minutes (300000ms)
                            // In Demo mode, we also auto-close to avoid "zombie" trades
                            if (!isFresh && Date.now() - newLastPriceUpdate > 300000) {
                                addLog(`⚠️ Token ${trade.symbol} stale >5m. Auto-closing as loss.`);
                                sellToken(trade.mint, 100);
                                updates.set(trade.mint, { status: "closed" });
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
                setActiveTrades(prev => prev.map(t => {
                    if (updates.has(t.mint)) {
                        const update = updates.get(t.mint);
                        // Merge update
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
                exitStrategy
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

        // Pre-trade balance check: Amount + Priority Fee (~0.001) + Account Rent Buffer (0.002)
        const safetyBuffer = amountSol <= 0.05 ? 0.01 : 0.025;
        try {
            const bal = await getBalance(wallet.publicKey.toBase58(), connection);
            if (bal < amountSol + safetyBuffer) {
                addLog(`Error: Insufficient balance. Have ${bal.toFixed(4)} SOL, need ~${(amountSol + safetyBuffer).toFixed(4)} SOL (incl. fees/rent)`);
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
            connection.confirmTransaction(signature, 'confirmed').then((res) => {
                if (!res.value.err) {
                    addLog(`✅ Buy Confirmed for ${symbol}!`);
                } else {
                    addLog(`❌ Buy Failed on-chain for ${symbol}.`);
                }
                syncTrades();
            }).catch(() => {
                // Fallback to sync after 15s if confirmTransaction times out
                setTimeout(() => syncTrades(), 15000);
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
                        setActiveTrades(prev => prev.map(t => t.mint === trade.mint ? { ...t, status: "closed" } : t));
                        addLog(`Synced: ${trade.symbol} has 0 balance after 60s. Marking as closed.`);
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
                            buyPrice: price, // We don't know the real buy price, so assume current
                            amountTokens: balance,
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
        localStorage.removeItem('pump_active_trades');
        addLog("Summary: Portfolio wiped (local data only).");
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
        setVaultBalance(prev => prev - amount);
        if (isDemo) {
            setDemoBalance(prev => prev + amount);
            addLog(`💰 Withdrew ${amount.toFixed(4)} SOL from vault to trading balance`);
        } else {
            addLog(`💰 Released ${amount.toFixed(4)} SOL from vault protection`);
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

    return {
        activeTrades,
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
        setProfitProtectionPercentage
    };
};
