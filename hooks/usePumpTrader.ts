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
}

export const usePumpTrader = (wallet: Keypair | null, connection: Connection, heliusKey?: string) => {
    const [activeTrades, setActiveTrades] = useState<ActiveTrade[]>([]);
    const [logs, setLogs] = useState<string[]>([]);
    const [isDemo, setIsDemo] = useState(false);
    const [demoBalance, setDemoBalance] = useState(10.0);
    const [stats, setStats] = useState({ totalProfit: 0, wins: 0, losses: 0 });
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
                const revenue = trade.amountTokens * sellPrice * (amountPercent / 100);
                const profit = revenue - (trade.buyPrice * trade.amountTokens * (amountPercent / 100));

                setDemoBalance(prev => prev + revenue);
                setStats(prev => ({
                    totalProfit: prev.totalProfit + profit,
                    wins: profit > 0 ? prev.wins + 1 : prev.wins,
                    losses: profit <= 0 ? prev.losses + 1 : prev.losses
                }));

                setActiveTrades(prev => prev.map(t => {
                    if (t.mint === mint) {
                        return { ...t, status: "closed", pnlPercent: t.buyPrice > 0 ? ((sellPrice - t.buyPrice) / t.buyPrice) * 100 : 0 };
                    }
                    return t;
                }));
                addLog(`[DEMO] Sold ${amountPercent}% at ${sellPrice.toFixed(9)} SOL. Rev: ${revenue.toFixed(4)} SOL`);
                toast.success(`[DEMO] Sold ${amountPercent}% of ${trade.symbol}`, { description: `Rev: ${revenue.toFixed(4)} SOL` });
                return;
            }

            if (!wallet) return;

            const balance = await getTokenBalance(wallet.publicKey.toBase58(), mint, connection);

            if (balance === 0) {
                addLog(`Sell Failed: No balance found for ${trade.symbol}`);
                return;
            }

            const amountToSell = balance * (amountPercent / 100);
            const priorityFee = Math.max(0.001, Math.min(0.005, (trade.amountSolPaid || 0.1) * 0.1));
            const transactionBuffer = await getTradeTransaction({
                publicKey: wallet.publicKey.toBase58(),
                action: "sell",
                mint,
                amount: amountToSell,
                denominatedInSol: "false",
                slippage: 15,
                priorityFee,
                pool: "pump"
            });

            const signature = await signAndSendTransaction(connection, transactionBuffer, wallet);
            addLog(`Sell Tx Sent: ${signature.substring(0, 8)}...`);
            toast.success(`Sell Tx Sent for ${trade.symbol}`, { description: `Tx: ${signature.substring(0, 8)}...` });

            setActiveTrades(prev => prev.map(t => {
                if (t.mint === mint) {
                    return { ...t, status: "closed" };
                }
                return t;
            }));
        } catch (error: any) {
            addLog(`Sell Error: ${error.message}`);
            toast.error(`Sell Error: ${trade.symbol}`, { description: error.message });
        }
    }, [wallet, isDemo, activeTrades, connection, addLog, setDemoBalance, setStats, setActiveTrades]);

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
        const pollInterval = hasFirstBuyerTrades ? 2000 : (isDemo ? 3000 : 12000);
        
        // Immediate price update on mount/change (don't wait for interval)
        const updatePrices = async () => {
            const openTrades = activeTrades.filter(t => t.status === "open");
            // For first buyer mode or demo mode, poll all trades more frequently
            const tradesToPoll = (hasFirstBuyerTrades || isDemo) ? openTrades : openTrades.slice(0, 10);
            if (tradesToPoll.length === 0) return;

            for (const trade of tradesToPoll) {
                try {
                    let price = 0;

                    // DEMO MODE: Always use REAL prices from blockchain (even for demo trades)
                    // Only use simulated prices for SIM tokens when NOT in demo mode (simulation mode)
                    if (trade.mint.startsWith('SIM') && !isDemo) {
                        // Simulate realistic price movement (only for simulation mode, not demo mode)
                        // Good tokens tend to go up, rugs go down
                        const isRug = trade.symbol.includes("Garbage") || trade.symbol.includes("Rug") || 
                                     trade.symbol.includes("Scam") || trade.symbol.includes("Fake");
                        
                        // Ensure we have a valid starting price
                        const basePrice = trade.currentPrice > 0 ? trade.currentPrice : (trade.buyPrice > 0 ? trade.buyPrice : 0.000001);
                        
                        // Calculate time since buy to simulate realistic price action
                        const timeSinceBuy = trade.buyTime ? (Date.now() - trade.buyTime) / 1000 : 0; // seconds
                        const minutesSinceBuy = timeSinceBuy / 60;
                        
                        if (isRug) {
                            // Rugs: High volatility, strong downward trend
                            // Early: might pump briefly, then crash
                            const volatility = 0.12; // 12% max swing
                            let drift = -0.02; // Strong downward bias
                            
                            // Early pump phase (first 30 seconds) - might go up briefly
                            if (timeSinceBuy < 30 && Math.random() > 0.7) {
                                drift = 0.05; // Brief pump
                            }
                            
                            const change = 1 + (Math.random() * volatility * 2 - volatility) + drift;
                            price = Math.max(0.000001, basePrice * change);
                        } else {
                            // Good tokens: Moderate volatility, upward trend
                            // Early momentum phase: stronger upward drift
                            const volatility = 0.08; // 8% max swing
                            let drift = 0.01; // Base upward bias
                            
                            // Early momentum (first 2 minutes) - stronger pump
                            if (minutesSinceBuy < 2) {
                                drift = 0.03 + (Math.random() * 0.05); // 3-8% upward drift
                            } else if (minutesSinceBuy < 5) {
                                drift = 0.015 + (Math.random() * 0.02); // 1.5-3.5% upward drift
                            }
                            
                            const change = 1 + (Math.random() * volatility * 2 - volatility) + drift;
                            price = Math.max(0.000001, basePrice * change);
                        }
                    } else {
                        // REAL MODE or DEMO MODE: Always fetch real prices from blockchain
                        // Demo mode tracks real tokens with real prices, just doesn't spend real SOL
                        try {
                            price = await getPumpPrice(trade.mint, connection);
                            if (price === 0) {
                                // Price fetch returned 0 - might be an error or token rugged
                                // For demo mode, if RPC fails, keep using current price (don't update to 0)
                                if (isDemo && trade.currentPrice > 0) {
                                    // Keep current price if RPC fails - WebSocket will update it
                                    price = trade.currentPrice;
                                    console.warn(`[Price Poll] ${trade.symbol}: RPC returned 0, keeping current price ${price.toFixed(9)}`);
                                } else {
                                    console.warn(`[Price Poll] ${trade.symbol}: getPumpPrice returned 0`);
                                }
                            }
                        } catch (error: any) {
                            console.error(`[Price Poll] Error fetching price for ${trade.symbol}:`, error.message);
                            // For demo mode, if RPC fails, keep using current price
                            if (isDemo && trade.currentPrice > 0) {
                                price = trade.currentPrice;
                            } else {
                                price = 0; // Set to 0 on error
                            }
                        }
                    }

                    // Use current price if RPC returned 0 but we have a valid current price (for demo mode)
                    const priceToUse = price > 0 ? price : (isDemo && trade.currentPrice > 0 ? trade.currentPrice : price);
                    
                    if (priceToUse > 0) {
                        // Fetch current liquidity to detect drains (rug pull indicator)
                        let currentLiquidity = 0;
                        try {
                            const pumpData = await getPumpData(trade.mint, connection);
                            if (pumpData) {
                                currentLiquidity = pumpData.vSolInBondingCurve;
                            }
                        } catch (e) {
                            // Ignore errors, continue with price update
                        }
                        
                        setActiveTrades(prev => prev.map(t => {
                            if (t.mint === trade.mint && t.status === "open") {
                                // CRITICAL FIX: If buyPrice is 0 or invalid, use current price as buyPrice
                                // This ensures PnL calculation works even if initial price fetch failed
                                let buyPrice = t.buyPrice;
                                if (buyPrice === 0 || buyPrice < 0.000000001) {
                                    // If buyPrice is invalid, set it to current price (first valid price we get)
                                    buyPrice = priceToUse;
                                    addLog(`[${trade.symbol}] Setting buyPrice to ${priceToUse.toFixed(9)} (was invalid)`);
                                }
                                
                                // Calculate PnL with the price we're using
                                const pnl = buyPrice > 0 ? ((priceToUse - buyPrice) / buyPrice) * 100 : 0;
                                
                                // LIQUIDITY DRAIN DETECTION: Exit immediately if liquidity drops significantly
                                // This is a critical rug pull indicator
                                if (currentLiquidity > 0 && t.lastPriceUpdate) {
                                    // Try to get previous liquidity from trade metadata or estimate
                                    const previousLiquidity = (t as any).lastLiquidity || currentLiquidity;
                                    const liquidityDrop = previousLiquidity > 0 ? ((previousLiquidity - currentLiquidity) / previousLiquidity) * 100 : 0;
                                    
                                    // If liquidity dropped by more than 20%, it's likely a rug - EXIT IMMEDIATELY
                                    if (liquidityDrop > 20 && previousLiquidity > 5) {
                                        addLog(`🚨 LIQUIDITY DRAIN DETECTED: ${trade.symbol} liquidity dropped ${liquidityDrop.toFixed(1)}% (${previousLiquidity.toFixed(2)} → ${currentLiquidity.toFixed(2)} SOL). RUG PULL! Exiting...`);
                                        toast.error(`RUG PULL DETECTED: ${trade.symbol}`, { description: `Liquidity dropped ${liquidityDrop.toFixed(1)}%. Selling!` });
                                        // Exit immediately - don't wait for next cycle
                                        setTimeout(() => {
                                            sellToken(trade.mint, 100);
                                        }, 100);
                                        return { ...t, status: "selling" as const };
                                    }
                                    
                                    // Store current liquidity for next check
                                    (t as any).lastLiquidity = currentLiquidity;
                                }
                                
                                // Calculate PnL - ensure we have valid buyPrice (use pnl we calculated above)
                                const calculatedPnl = pnl;

                                // Define stop loss threshold (negative value)
                                const stopLossThreshold = -(t.exitStrategy?.stopLoss || 10);
                                
                                // Track highest price for trailing stop
                                const highestPrice = t.highestPrice ? Math.max(t.highestPrice, priceToUse) : priceToUse;

                                // === SMART EXIT STRATEGY ===
                                
                                // 1. STAGED SELLS (Secure Profits)
                                // If PnL hits 100% (2x), sell 50% to get initial investment back (risk-free)
                                if (calculatedPnl >= 100 && !(t.partialSells && t.partialSells[100])) {
                                    const percentToSell = 50;
                                    addLog(`💰 2X TARGET HIT: ${trade.symbol} is up ${calculatedPnl.toFixed(0)}%. Selling ${percentToSell}% to secure principal.`);
                                    toast.success(`2X HIT: ${trade.symbol}`, { description: "Selling 50% to risk-free the trade" });
                                    
                                    // Execute partial sell
                                    sellToken(trade.mint, percentToSell);
                                    
                                    // Mark as partially sold so we don't sell again for this target
                                    return {
                                        ...t,
                                        partialSells: { ...(t.partialSells || {}), 100: true }
                                    };
                                }
                                
                                // 2. TRAILING STOP LOSS (Protect Gains)
                                // Dynamic trailing stop based on how high it has gone
                                let dynamicStopLoss = stopLossThreshold;
                                let trailingStopReason = "Stop Loss";
                                
                                if (highestPrice > buyPrice) {
                                    const highestPnl = ((highestPrice - buyPrice) / buyPrice) * 100;
                                    
                                    // Tiered Trailing Stop
                                    if (highestPnl > 200) {
                                        // If > 3x, trail by 20%
                                        const trailPrice = highestPrice * 0.8;
                                        const trailPnl = ((trailPrice - buyPrice) / buyPrice) * 100;
                                        dynamicStopLoss = Math.max(stopLossThreshold, trailPnl);
                                        trailingStopReason = "Trailing Stop (Tier 3)";
                                    } else if (highestPnl > 100) {
                                        // If > 2x, trail by 15%
                                        const trailPrice = highestPrice * 0.85;
                                        const trailPnl = ((trailPrice - buyPrice) / buyPrice) * 100;
                                        dynamicStopLoss = Math.max(stopLossThreshold, trailPnl);
                                        trailingStopReason = "Trailing Stop (Tier 2)";
                                    } else if (highestPnl > 50) {
                                        // If > 1.5x, trail by 10%
                                        const trailPrice = highestPrice * 0.9;
                                        const trailPnl = ((trailPrice - buyPrice) / buyPrice) * 100;
                                        dynamicStopLoss = Math.max(stopLossThreshold, trailPnl);
                                        trailingStopReason = "Trailing Stop (Tier 1)";
                                    }
                                }

                                // CRITICAL: If PnL drops below dynamic stop loss threshold, exit immediately
                                if (calculatedPnl <= dynamicStopLoss && buyPrice > 0) {
                                    console.warn(`[Price Poll] ${trade.symbol}: PnL ${calculatedPnl.toFixed(2)}% hit ${trailingStopReason} at ${dynamicStopLoss.toFixed(2)}%`);
                                    addLog(`🛑 ${trade.symbol}: ${trailingStopReason} triggered at ${calculatedPnl.toFixed(2)}%`);
                                    toast.warning(`${trailingStopReason}: ${trade.symbol}`, { description: `Secured PnL: ${calculatedPnl.toFixed(2)}%` });
                                    
                                    // Exit immediately - don't wait for next cycle
                                    setTimeout(() => {
                                        sellToken(trade.mint, 100);
                                    }, 100);
                                    
                                    return { ...t, status: "selling" as const };
                                }
                                
                                // Safety check: If price dropped to near zero, it's likely a rug
                                // Still update the price so we can see the -100% PnL and trigger stop loss
                                if (priceToUse < buyPrice * 0.0001 && buyPrice > 0) {
                                    // Price dropped by more than 99.99% - likely a rug
                                    // Update price anyway so stop loss triggers, but log it
                                    console.warn(`[Price Poll] ${trade.symbol}: Price dropped 99.99%+ (${buyPrice.toFixed(9)} → ${priceToUse.toFixed(9)}) - likely rug`);
                                    addLog(`🚨 ${trade.symbol}: Price crashed 99.99%+ - likely rug pull`);
                                    // If not already triggered above, exit immediately (rug pull = instant -100%)
                                    if (calculatedPnl > stopLossThreshold) {
                                        setTimeout(() => {
                                            sellToken(trade.mint, 100);
                                        }, 100);
                                    }
                                }
                                
                                // Debug logging for price updates (only log if price changed significantly)
                                const priceChange = t.currentPrice > 0 ? ((priceToUse - t.currentPrice) / t.currentPrice) * 100 : 0;
                                if (Math.abs(priceChange) > 1 || t.currentPrice === 0) {
                                    console.log(`[Price Update] ${trade.symbol}: ${t.currentPrice.toFixed(9)} → ${priceToUse.toFixed(9)} (${calculatedPnl.toFixed(2)}% PnL)`);
                                }

                                return {
                                    ...t,
                                    buyPrice, // Always use valid buyPrice
                                    currentPrice: priceToUse,
                                    pnlPercent: calculatedPnl,
                                    highestPrice,

                                    lastPriceUpdate: Date.now(),
                                    lastPriceChangeTime: priceToUse !== t.currentPrice ? Date.now() : t.lastPriceChangeTime,
                                    lastLiquidity: currentLiquidity // Store for drain detection
                                };
                            }
                            return t;
                        }));

                        // Check for stale tokens (No price change for 3 minutes)
                        const staleThreshold = 3 * 60 * 1000;
                        if (!isDemo && trade.lastPriceChangeTime && (Date.now() - trade.lastPriceChangeTime > staleThreshold)) {
                            addLog(`Stale Token: No movement on ${trade.symbol} for 3 mins. Selling...`);
                            sellToken(trade.mint, 100);
                        }
                    } else if (price === 0) {
                        // Price fetch returned 0 - log for debugging
                        console.warn(`[Price Poll] ${trade.symbol}: Price is 0, skipping update. buyPrice: ${trade.buyPrice}, currentPrice: ${trade.currentPrice}`);
                    }
                } catch (e: any) {
                    console.error(`[Price Poll] Error for ${trade.symbol}:`, e.message);
                    if (e.message?.includes('429')) {
                        console.warn("Helius Rate Limit Hit during polling. Slowing down...");
                    }
                }
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
                        // If still 0, calculate from token data if available
                        addLog(`[DEMO] Price fetch returned 0, will update on next poll`);
                        buyPrice = 0.000001; // Temporary placeholder, will be updated by price polling
                    }
                } catch (e) {
                    addLog(`[DEMO] Error fetching price, will update on next poll`);
                    buyPrice = 0.000001; // Temporary placeholder
                }
            }

            const amountTokens = buyPrice > 0 ? amountSol / buyPrice : amountSol;

            const newTrade: ActiveTrade = {
                mint,
                symbol,
                buyPrice,
                amountTokens,
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
        stats
    };
};
