"use client";

import React, { useEffect, useState, useRef, memo } from 'react';
import { Activity, ExternalLink, TrendingUp, RefreshCw, WifiOff, Zap } from 'lucide-react';
import { getTokenMetadata, getPumpData } from '../utils/solanaManager';

export interface TokenData {
    mint: string;
    traderPublicKey: string;
    txType: "create" | "buy" | "sell";
    initialBuy: number;
    bondingCurveKey: string;
    vTokensInBondingCurve: number;
    vSolInBondingCurve: number;
    marketCapSol: number;
    name: string;
    symbol: string;
    uri: string;
    timestamp: number;
}

// Memoized Token Item for Performance
const TokenItem = memo((props: any) => {
    const { index, style, tokens } = props;
    const token = tokens[index];
    if (!token) return null;
    
    const isSim = token.mint.startsWith('SIM');
    const pumpFunUrl = isSim ? null : `https://pump.fun/${token.mint}`;

    return (
        <div style={style} className="px-1 pb-2">
            <div className={`p-3 h-full rounded border transition-all ${isSim ? 'bg-blue-500/5 border-blue-500/20' : 'bg-[#121212]/50 border-[#222] hover:border-[var(--primary)]'}`}>
                <div className="flex justify-between items-start">
                    <div className="flex-1 overflow-hidden">
                        <h3 className="font-bold text-sm text-white flex items-center gap-2 truncate">
                            {token.symbol || 'Unknown'}
                            {isSim && <span className="text-[8px] bg-blue-500 px-1 rounded flex-shrink-0">SIM</span>}
                        </h3>
                        <p className="text-[10px] text-gray-500 font-mono truncate">{token.mint}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                        <Activity size={12} className={(token.initialBuy || 0) > 1 ? "text-green-500" : "text-gray-600"} />
                        {pumpFunUrl && (
                            <a
                                href={pumpFunUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[var(--primary)] hover:text-white transition-colors"
                                title="View on pump.fun"
                            >
                                <ExternalLink size={12} />
                            </a>
                        )}
                    </div>
                </div>
                <div className="flex justify-between text-[10px] text-gray-400 mt-2">
                    <span>{(token.vSolInBondingCurve || 0).toFixed(1)} SOL</span>
                    <span>{new Date(token.timestamp || Date.now()).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                </div>
            </div>
        </div>
    );
});
TokenItem.displayName = 'TokenItem';

interface LiveFeedProps {
    onTokenDetected: (token: TokenData) => void;
    isDemo?: boolean;
    isSimulating?: boolean;
    heliusKey?: string;
}

export default function LiveFeed({ onTokenDetected, isDemo = false, isSimulating = false, heliusKey = "" }: LiveFeedProps) {
    const [tokens, setTokens] = useState<TokenData[]>([]);
    const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "simulating">("connecting");
    const [retryCount, setRetryCount] = useState(0);

    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);
    const connectionTimeout = useRef<NodeJS.Timeout | null>(null);
    const simulationInterval = useRef<NodeJS.Timeout | null>(null);
    const [lastError, setLastError] = useState<string>("");

    const onTokenDetectedRef = useRef(onTokenDetected);
    useEffect(() => { onTokenDetectedRef.current = onTokenDetected; }, [onTokenDetected]);

    // Validate Helius API key format (should be UUID-like, not placeholder)
    const isValidHeliusKey = (key: string): boolean => {
        if (!key || key.trim() === '') return false;
        const trimmed = key.trim();
        // Helius keys are UUIDs (36 chars with dashes) or long hex strings
        // Reject obvious placeholders
        const invalidPatterns = ['admin', 'test', 'demo', 'key', 'placeholder'];
        const lowerKey = trimmed.toLowerCase();
        if (invalidPatterns.some(pattern => lowerKey.includes(pattern) && trimmed.length < 30)) {
            return false;
        }
        // UUID format: 8-4-4-4-12 (36 chars total) or long hex string (32+ chars)
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return uuidPattern.test(trimmed) || trimmed.length >= 32;
    };

    const connectWs = () => {
        if (isSimulating) {
            setStatus("simulating");
            return;
        }

        if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
            return;
        }

        setLastError("");
        setStatus("connecting");

        if (connectionTimeout.current) clearTimeout(connectionTimeout.current);
        connectionTimeout.current = setTimeout(() => {
            if (wsRef.current?.readyState !== WebSocket.OPEN) {
                setLastError("Timeout: Connection failed");
                wsRef.current?.close();
                setStatus("disconnected");
            }
        }, 8000);

        try {
            // Check if Helius key is valid, otherwise use public feed
            const useHelius = heliusKey && isValidHeliusKey(heliusKey);
            const url = useHelius
                ? `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}`
                : 'wss://pumpportal.fun/api/data';

            if (heliusKey && !isValidHeliusKey(heliusKey)) {
                setLastError("Invalid Helius key - using public feed");
            }

            const ws = new WebSocket(url);
            wsRef.current = ws;

            ws.onopen = () => {
                if (connectionTimeout.current) clearTimeout(connectionTimeout.current);
                setRetryCount(0);
                setStatus("connected");
                setLastError("");

                if (useHelius) {
                    console.log("[LiveFeed] ✅ Connected to Helius, subscribing to pump.fun program logs...");
                    // Subscribe to logs for pump.fun program (catches token creation)
                    ws.send(JSON.stringify({
                        jsonrpc: "2.0", id: 1, method: "logsSubscribe",
                        params: [{ mentions: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"] }, { commitment: "processed" }]
                    }));
                    // Note: Account subscription removed - too many notifications, logs are sufficient
                } else {
                    console.log("[LiveFeed] ✅ Connected to PumpPortal feed...");
                    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
                }
            };

            ws.onmessage = async (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (useHelius) {
                        // Handle log notifications (token creation events)
                        if (data.method === "logsNotification") {
                            const logs = data.params.result.value.logs as string[];
                            const signature = data.params.result.value.signature;
                        // Check for various instruction types that indicate token creation
                        const createPatterns = ["Instruction: Create", "create", "Create", "initialize", "Initialize", "new_token", "NewToken"];
                        const hasCreateInstruction = logs.some(log => 
                            createPatterns.some(pattern => log.includes(pattern))
                        );
                        if (hasCreateInstruction) {
                            console.log(`[LiveFeed] 🎯 Detected token creation: ${signature.substring(0, 16)}...`);
                            handleNewTokenSignature(signature);
                        }
                            return;
                        }
                    }
                    // Handle PumpPortal feed messages
                    if (data.mint) {
                        const newToken: TokenData = { ...data, timestamp: Date.now(), marketCapSol: data.vSolInBondingCurve || 0 };
                        updateTokens(newToken);
                    }
                } catch (e) {
                    console.warn("[LiveFeed] Error parsing WebSocket message:", e);
                }
            };

            ws.onclose = (event) => {
                if (connectionTimeout.current) clearTimeout(connectionTimeout.current);
                if (!isSimulating) {
                    setStatus("disconnected");
                    // If Helius failed and we have a key, try falling back to public feed
                    if (useHelius && heliusKey && event.code !== 1000) {
                        setLastError("Helius failed - retry with public feed");
                        // Auto-retry with public feed after 2 seconds
                        setTimeout(() => {
                            if (wsRef.current?.readyState !== WebSocket.OPEN) {
                                connectWs(); // Will use public feed since useHelius will be false
                            }
                        }, 2000);
                    }
                }
            };

            ws.onerror = (error) => {
                if (useHelius) {
                    setLastError("Helius API Error (Invalid key?)");
                } else {
                    setLastError("Connection Error");
                }
            };
        } catch (err: any) {
            setLastError("WS Failed");
            setStatus("disconnected");
        }
    };

    const handleNewTokenSignature = async (signature: string) => {
        try {
            const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: "2.0", id: "get-tx", method: "getTransaction",
                    params: [signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]
                })
            });
            const txData = await response.json();
            if (txData.result?.meta?.postTokenBalances?.length > 0) {
                const mint = txData.result.meta.postTokenBalances[0].mint;
                const meta = await getTokenMetadata(mint, heliusKey);
                const pumpData = await getPumpData(mint);
                const newToken: TokenData = {
                    mint,
                    traderPublicKey: txData.result.transaction.message.accountKeys[0].pubkey || txData.result.transaction.message.accountKeys[0],
                    txType: "create",
                    initialBuy: 0,
                    bondingCurveKey: "",
                    vTokensInBondingCurve: pumpData?.vTokensInBondingCurve || 1073000000,
                    vSolInBondingCurve: pumpData?.vSolInBondingCurve || 30,
                    marketCapSol: pumpData?.vSolInBondingCurve || 30,
                    name: meta.name,
                    symbol: meta.symbol,
                    uri: "",
                    timestamp: Date.now()
                };
                updateTokens(newToken);
            }
        } catch (e) { }
    };

    const updateTokens = (token: TokenData) => {
        setTokens(prev => {
            if (prev.some(t => t.mint === token.mint)) return prev;
            return [token, ...prev].slice(0, 50);
        });
        onTokenDetectedRef.current(token);
    };

    useEffect(() => {
        if (isSimulating) {
            if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
            if (simulationInterval.current) clearInterval(simulationInterval.current);
            setStatus("simulating");
            simulationInterval.current = setInterval(() => {
                const randomMint = "SIM" + Math.random().toString(36).substring(7).toUpperCase();
                const symbols = ["SOL", "PUMP", "MOON", "APE", "SAFE", "DIAMOND", "ROCKET", "BULL", "GEM", "STAR"];
                const randomSymbol = symbols[Math.floor(Math.random() * symbols.length)] + Math.floor(Math.random() * 99);
                
                // More realistic distribution: 60% rugs, 30% mediocre, 10% good (better than 98.6% rugs in reality)
                const rand = Math.random();
                let isRug = false;
                let devBuy = 0.1;
                let name = "Garbage Coin";
                let liquidity = 30;
                
                if (rand < 0.6) {
                    // 60% rugs - low dev buy, no commitment
                    isRug = true;
                    devBuy = 0.05 + Math.random() * 0.3; // 0.05-0.35 SOL
                    name = ["Garbage Coin", "Rug Pull", "Scam Token", "Fake Coin"][Math.floor(Math.random() * 4)];
                    liquidity = 30 + Math.random() * 5; // Minimal growth
                } else if (rand < 0.9) {
                    // 30% mediocre - some dev buy but not great
                    devBuy = 0.5 + Math.random() * 1.5; // 0.5-2.0 SOL
                    name = ["Average Token", "Meh Coin", "Okay Token"][Math.floor(Math.random() * 3)];
                    liquidity = 30 + Math.random() * 10; // Some growth
                } else {
                    // 10% good tokens - high dev commitment
                    devBuy = 2.0 + Math.random() * 8; // 2.0-10.0 SOL
                    name = ["Diamond Hook", "Moon Shot", "Rocket Fuel", "Gem Token", "Bull Run"][Math.floor(Math.random() * 5)];
                    liquidity = 30 + Math.random() * 20 + 5; // Good growth
                }
                
                const mockToken: TokenData = {
                    mint: randomMint, 
                    traderPublicKey: "SIM", 
                    txType: "create", 
                    initialBuy: devBuy,
                    bondingCurveKey: "SIM", 
                    vTokensInBondingCurve: 1073000000, 
                    vSolInBondingCurve: liquidity, 
                    marketCapSol: liquidity,
                    name: name, 
                    symbol: randomSymbol, 
                    uri: "", 
                    timestamp: Date.now()
                };
                updateTokens(mockToken);
            }, 5000);
        } else {
            if (simulationInterval.current) { clearInterval(simulationInterval.current); simulationInterval.current = null; }
            connectWs();
        }
        return () => {
            if (simulationInterval.current) clearInterval(simulationInterval.current);
        };
    }, [isSimulating, heliusKey]);

    const manualReconnect = () => {
        setRetryCount(prev => prev + 1);
        if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
        connectWs();
    };

    return (
        <div className="glass-panel p-6 w-full h-[600px] flex flex-col animate-fade-in">
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold glow-text flex items-center gap-2">
                    <Activity size={20} className="text-[var(--primary)]" /> Market Feed
                </h2>
                <div className="flex items-center gap-2">
                    {lastError && !isSimulating && <span className="text-[10px] text-red-400 bg-red-400/10 px-2 py-0.5 rounded">{lastError}</span>}
                    
                    <div className={`flex items-center gap-2 px-2 py-1 rounded-full border ${status === "connected" ? "bg-green-500/10 border-green-500/20 text-green-500" : status === "simulating" ? "bg-blue-500/10 border-blue-500/20 text-blue-500" : status === "connecting" ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-500" : "bg-red-500/10 border-red-500/20 text-red-500"}`}>
                        <div className={`w-1.5 h-1.5 rounded-full ${status === "connected" ? "bg-green-500 animate-pulse" : status === "simulating" ? "bg-blue-500 animate-pulse" : status === "connecting" ? "bg-yellow-500 animate-pulse" : "bg-red-500"}`}></div>
                        <span className="text-[10px] font-medium uppercase tracking-wider">{status}</span>
                    </div>

                    {status === "disconnected" && !isSimulating && (
                        <button onClick={manualReconnect} className="p-1 hover:text-white text-gray-400 transition-colors">
                            <RefreshCw size={14} className={retryCount > 0 ? "animate-spin" : ""} />
                        </button>
                    )}
                </div>
            </div>

            <div className="flex-1 pr-2 space-y-3 custom-scrollbar h-full">
                {tokens.length === 0 ? (
                    <div className="text-center text-gray-500 mt-20">
                        {status === "disconnected" ? <WifiOff className="mx-auto mb-2 opacity-20" size={48} /> : <div className="loading-spinner mx-auto mb-2" />}
                        <p>{status === "disconnected" ? "Connection Lost" : "Scanning Market..."}</p>
                        <p className="text-[10px] opacity-50 mt-1">{isSimulating ? "Simulating for Paper Trade" : "Waiting for new Pump.fun tokens"}</p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {tokens.map((token, index) => (
                            <TokenItem key={token.mint} index={index} style={{}} tokens={tokens} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
