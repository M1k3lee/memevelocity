"use client";

import React, { useEffect, useState, useRef, memo } from 'react';
import { Activity, ExternalLink, TrendingUp, RefreshCw, WifiOff, ShieldAlert, ShieldCheck, Zap, AlertTriangle, Pause, Play } from 'lucide-react';
import { getTokenMetadata, getPumpData } from '../utils/solanaManager';
import { quickRugCheck, detectRug } from '../utils/rugDetector';

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

    // Run quick rug check
    const rugCheck = detectRug(token, 'medium');
    const isRug = rugCheck.isRug;
    const isSafe = !isRug && (token.vSolInBondingCurve || 0) > 35; // slightly safer if liquidity > 35

    // Determine status color/badge
    let badgeColor = "bg-gray-500/10 text-gray-500 border-gray-500/20";
    let badgeText = "UNK";
    let borderColor = "border-[#222]";

    if (isRug) {
        badgeColor = "bg-red-500/10 text-red-500 border-red-500/20";
        badgeText = "RUG";
        borderColor = "border-red-500/30";
    } else if (isSafe) {
        badgeColor = "bg-green-500/10 text-green-500 border-green-500/20";
        badgeText = "GOOD";
        borderColor = "border-green-500/30";
    } else {
        // Neutral/New
        badgeColor = "bg-blue-500/10 text-blue-500 border-blue-500/20";
        badgeText = "NEW";
        borderColor = "border-blue-500/30 hover:border-blue-400";
    }

    return (
        <div style={style} className="px-1 pb-2">
            <div className={`p-3 h-full rounded border transition-all ${isSim ? 'bg-blue-900/5' : 'bg-[#121212]/80'} ${borderColor} hover:scale-[1.01] hover:shadow-lg`}>
                <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2 overflow-hidden max-w-[70%]">
                        <div className={`flex items-center justify-center w-8 h-8 rounded-full ${isRug ? 'bg-red-500/20 text-red-500' : isSafe ? 'bg-green-500/20 text-green-500' : 'bg-blue-500/20 text-blue-500'}`}>
                            {isRug ? <ShieldAlert size={16} /> : isSafe ? <ShieldCheck size={16} /> : <Zap size={16} />}
                        </div>
                        <div className="overflow-hidden">
                            <h3 className="font-bold text-sm text-white truncate flex items-center gap-1">
                                {token.symbol || 'Unknown'}
                                {isSim && <span className="text-[9px] bg-blue-500 px-1 rounded-sm text-white">SIM</span>}
                            </h3>
                            <p className="text-[10px] text-gray-500 font-mono truncate">{token.name}</p>
                        </div>
                    </div>

                    <div className="flex flex-col items-end gap-1">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-bold ${badgeColor}`}>
                            {badgeText}
                        </span>
                        {pumpFunUrl && (
                            <a href={pumpFunUrl} target="_blank" rel="noopener noreferrer"
                                className="text-gray-500 hover:text-[var(--primary)] transition-colors" title="View on Pump.fun">
                                <ExternalLink size={12} />
                            </a>
                        )}
                    </div>
                </div>

                <div className="flex justify-between items-center text-[10px] text-gray-400 bg-black/20 p-2 rounded">
                    <div className="flex flex-col">
                        <span className="text-gray-600 uppercase text-[9px]">Liquidity</span>
                        <span className={(token.vSolInBondingCurve || 0) > 30 ? "text-green-400" : "text-gray-300"}>
                            {(token.vSolInBondingCurve || 0).toFixed(1)} SOL
                        </span>
                    </div>
                    <div className="flex flex-col items-end">
                        <span className="text-gray-600 uppercase text-[9px]">Time</span>
                        <span className="font-mono text-gray-300">
                            {new Date(token.timestamp || Date.now()).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                    </div>
                </div>

                {/* Rug Reason / Warning */}
                {rugCheck.warnings.length > 0 && !isRug && (
                    <div className="mt-2 text-[10px] text-yellow-500 flex items-start gap-1 p-1 bg-yellow-500/5 rounded border border-yellow-500/10">
                        <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                        <span className="italic leading-tight opacity-80">{rugCheck.warnings[0]}</span>
                    </div>
                )}
                {isRug && rugCheck.reason && (
                    <div className="mt-2 text-[10px] text-red-400 flex items-start gap-1 p-1 bg-red-500/5 rounded border border-red-500/10">
                        <ShieldAlert size={10} className="mt-0.5 flex-shrink-0" />
                        <span className="italic leading-tight font-medium">{rugCheck.reason}</span>
                    </div>
                )}
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
    const [paused, setPaused] = useState(false);

    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);
    const connectionTimeout = useRef<NodeJS.Timeout | null>(null);
    const simulationInterval = useRef<NodeJS.Timeout | null>(null);
    const [lastError, setLastError] = useState<string>("");

    const onTokenDetectedRef = useRef(onTokenDetected);
    useEffect(() => { onTokenDetectedRef.current = onTokenDetected; }, [onTokenDetected]);

    const isValidHeliusKey = (key: string): boolean => {
        if (!key || key.trim() === '') return false;
        const trimmed = key.trim();
        const invalidPatterns = ['admin', 'test', 'demo', 'key', 'placeholder'];
        const lowerKey = trimmed.toLowerCase();
        if (invalidPatterns.some(pattern => lowerKey.includes(pattern) && trimmed.length < 30)) return false;
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
                    console.log("[LiveFeed] ✅ Connected to Helius");
                    ws.send(JSON.stringify({
                        jsonrpc: "2.0", id: 1, method: "logsSubscribe",
                        params: [{ mentions: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"] }, { commitment: "processed" }]
                    }));
                } else {
                    console.log("[LiveFeed] ✅ Connected to PumpPortal");
                    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
                }
            };

            ws.onmessage = async (event) => {
                if (paused) return; // Don't process if paused

                try {
                    const data = JSON.parse(event.data);
                    if (useHelius) {
                        if (data.method === "logsNotification") {
                            const logs = data.params.result.value.logs as string[];
                            const signature = data.params.result.value.signature;
                            const createPatterns = ["Instruction: Create", "create", "Create", "initialize", "Initialize", "new_token", "NewToken"];
                            if (logs.some(log => createPatterns.some(pattern => log.includes(pattern)))) {
                                handleNewTokenSignature(signature);
                            }
                            return;
                        }
                    }
                    if (data.mint) {
                        // Normalize vSol to SOL (PumpPortal sends lamports)
                        const vSol = data.vSolInBondingCurve ? data.vSolInBondingCurve / 1e9 : 0;
                        const newToken: TokenData = {
                            ...data,
                            vSolInBondingCurve: vSol,
                            timestamp: Date.now(),
                            marketCapSol: vSol || 0
                        };
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
                    if (useHelius && heliusKey && event.code !== 1000) {
                        setLastError("Helius failed - retrying");
                        setTimeout(() => { if (wsRef.current?.readyState !== WebSocket.OPEN) connectWs(); }, 2000);
                    }
                }
            };

            ws.onerror = (error) => {
                if (useHelius) setLastError("Helius API Error");
                else setLastError("Connection Error");
            };
        } catch (err: any) {
            setLastError("WS Failed");
            setStatus("disconnected");
        }
    };

    const handleNewTokenSignature = async (signature: string) => {
        if (paused) return;
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
                    vTokensInBondingCurve: pumpData?.vTokensInBondingCurve || 1073000000000000,
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
            // Keep last 50 tokens
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
                if (paused) return;

                const randomMint = "SIM" + Math.random().toString(36).substring(7).toUpperCase();
                const symbols = ["SOL", "PUMP", "MOON", "APE", "SAFE", "DIAMOND", "ROCKET", "BULL", "GEM", "STAR"];
                const randomSymbol = symbols[Math.floor(Math.random() * symbols.length)] + Math.floor(Math.random() * 99);
                const rand = Math.random();
                let isRug = false;
                let devBuy = 0.1;
                let name = "Garbage Coin";
                let liquidity = 30;

                if (rand < 0.6) {
                    isRug = true;
                    devBuy = 0.05 + Math.random() * 0.3;
                    name = ["Garbage Coin", "Rug Pull", "Scam Token", "Fake Coin"][Math.floor(Math.random() * 4)];
                    liquidity = 30 + Math.random() * 5;
                } else if (rand < 0.9) {
                    devBuy = 0.5 + Math.random() * 1.5;
                    name = ["Average Token", "Meh Coin", "Okay Token"][Math.floor(Math.random() * 3)];
                    liquidity = 30 + Math.random() * 10;
                } else {
                    devBuy = 2.0 + Math.random() * 8;
                    name = ["Diamond Hook", "Moon Shot", "Rocket Fuel", "Gem Token", "Bull Run"][Math.floor(Math.random() * 5)];
                    liquidity = 30 + Math.random() * 20 + 5;
                }

                const mockToken: TokenData = {
                    mint: randomMint,
                    traderPublicKey: "SIM",
                    txType: "create",
                    initialBuy: devBuy,
                    bondingCurveKey: "SIM",
                    vTokensInBondingCurve: 1073000000000000, // Correct scale: 1B tokens * 10^6 decimals = 10^15
                    vSolInBondingCurve: liquidity,
                    marketCapSol: liquidity,
                    name: name,
                    symbol: randomSymbol,
                    uri: "",
                    timestamp: Date.now()
                };
                updateTokens(mockToken);
            }, 3000); // Faster simulation
        } else {
            if (simulationInterval.current) { clearInterval(simulationInterval.current); simulationInterval.current = null; }
            connectWs();
        }
        return () => {
            if (simulationInterval.current) clearInterval(simulationInterval.current);
        };
    }, [isSimulating, heliusKey, paused]);

    const manualReconnect = () => {
        setRetryCount(prev => prev + 1);
        if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
        connectWs();
    };

    return (
        <div className="glass-panel p-6 w-full h-[600px] flex flex-col animate-fade-in relative overflow-hidden">
            {/* Background enhancement */}
            <div className="absolute top-0 right-0 p-32 bg-[var(--primary)]/5 rounded-full blur-[100px] pointer-events-none"></div>

            <div className="flex justify-between items-center mb-6 z-10">
                <div>
                    <h2 className="text-2xl font-bold glow-text flex items-center gap-3">
                        <div className="relative">
                            <Activity size={24} className="text-[var(--primary)]" />
                            <div className="absolute top-0 right-0 w-2 h-2 bg-[var(--primary)] rounded-full animate-ping"></div>
                        </div>
                        Market Intelligence
                    </h2>
                    <p className="text-xs text-gray-500 mt-1">Real-time analysis & rug detection</p>
                </div>

                <div className="flex items-center gap-3">
                    {lastError && !isSimulating && <span className="text-[10px] text-red-400 bg-red-400/10 px-2 py-1 rounded border border-red-500/20">{lastError}</span>}

                    <button onClick={() => setPaused(!paused)} className={`p-2 rounded-full border transition-all ${paused ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/50' : 'bg-[#222] text-gray-400 border-[#333] hover:text-white'}`}>
                        {paused ? <Play size={16} fill="currentColor" /> : <Pause size={16} fill="currentColor" />}
                    </button>

                    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border ${status === "connected" ? "bg-green-500/10 border-green-500/20 text-green-500" : status === "simulating" ? "bg-blue-500/10 border-blue-500/20 text-blue-500" : status === "connecting" ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-500" : "bg-red-500/10 border-red-500/20 text-red-500"}`}>
                        <div className={`w-2 h-2 rounded-full ${status === "connected" ? "bg-green-500 animate-pulse" : status === "simulating" ? "bg-blue-500 animate-pulse" : status === "connecting" ? "bg-yellow-500 animate-pulse" : "bg-red-500"}`}></div>
                        <span className="text-[10px] font-bold uppercase tracking-wider">{status}</span>
                    </div>

                    {status === "disconnected" && !isSimulating && (
                        <button onClick={manualReconnect} className="p-2 bg-[#222] rounded-full border border-[#333] hover:text-white text-gray-400 transition-colors hover:rotate-180 duration-500">
                            <RefreshCw size={16} />
                        </button>
                    )}
                </div>
            </div>

            <div className="bg-[#1a1a1a]/50 border border-[#222] rounded-lg p-3 mb-2 flex justify-between text-[10px] text-gray-400 tracking-wider font-mono uppercase z-10">
                <span>Token Analysis</span>
                <span>Status</span>
            </div>

            <div className="flex-1 pr-2 space-y-3 custom-scrollbar overflow-y-auto min-h-0 z-10 relative">
                {tokens.length === 0 ? (
                    <div className="text-center text-gray-500 mt-20 flex flex-col items-center">
                        {status === "disconnected" ? <WifiOff className="mb-4 opacity-20" size={64} /> : <div className="loading-spinner mb-4 w-12 h-12 border-4" />}
                        <p className="text-lg font-medium">{status === "disconnected" ? "Connection Lost" : "Scanning Market..."}</p>
                        <p className="text-xs opacity-50 mt-2 max-w-[200px]">{isSimulating ? "Simulating for Paper Trade" : "Analyzing incoming tokens from Pump.fun..."}</p>
                    </div>
                ) : (
                    <div className="space-y-2 pb-20">
                        {tokens.map((token, index) => (
                            <TokenItem key={token.mint} index={index} style={{}} tokens={tokens} />
                        ))}
                    </div>
                )}

                {/* Scroll fade effect */}
                <div className="fixed bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-[#050505] to-transparent pointer-events-none z-20"></div>
            </div>
        </div>
    );
}
