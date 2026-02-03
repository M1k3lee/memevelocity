"use client";

import React, { useEffect, useState, useRef, memo, useMemo } from 'react';
import { Activity, ExternalLink, RefreshCw, WifiOff, Zap, AlertTriangle, Pause, Play, Trash2, Diamond } from 'lucide-react';
import { getTokenMetadata, getPumpData, metadataCache, createConnection } from '../utils/solanaManager';
import { detectRug } from '../utils/rugDetector';

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

// Minimal Card for Junkyard
const JunkItem = memo(({ token, reason }: { token: TokenData, reason: string }) => (
    <div className="flex items-center justify-between p-2 mb-1 bg-red-500/5 border border-red-500/10 rounded opacity-60 hover:opacity-100 transition-opacity">
        <div className="flex items-center gap-2 overflow-hidden">
            <Trash2 size={12} className="text-red-500/50 flex-shrink-0" />
            <div className="flex flex-col overflow-hidden">
                <span className="text-[10px] font-bold text-red-400 truncate w-20">{token.symbol}</span>
                <span className="text-[9px] text-red-500/50 truncate w-24">{reason}</span>
            </div>
        </div>
        <span className="text-[9px] font-mono text-red-900/50">{new Date(token.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })}</span>
    </div>
));
JunkItem.displayName = 'JunkItem';

// Standard Card for Stream
const StreamItem = memo(({ token, rugCheck }: { token: TokenData, rugCheck: any }) => {
    const isSim = token.mint.startsWith('SIM');
    return (
        <div className="p-3 mb-2 rounded border border-[#222] bg-[#1a1a1a]/80 hover:border-blue-500/30 transition-all">
            <div className="flex justify-between items-start mb-1">
                <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-500">
                        <Zap size={12} />
                    </div>
                    <div>
                        <h3 className="text-xs font-bold text-gray-200 flex items-center gap-1">
                            {token.symbol}
                            {isSim && <span className="text-[8px] bg-blue-900 px-1 rounded text-blue-300">SIM</span>}
                        </h3>
                        <p className="text-[9px] text-gray-500 truncate max-w-[100px]">{token.name}</p>
                    </div>
                </div>
                <div className="text-right">
                    <div className="text-[10px] font-mono text-gray-400">
                        {new Date(token.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </div>
                    <a href={`https://pump.fun/${token.mint}`} target="_blank" rel="noopener noreferrer" className="text-[9px] text-blue-400 hover:text-blue-300 flex items-center justify-end gap-0.5">
                        Pump.fun <ExternalLink size={8} />
                    </a>
                </div>
            </div>
            <div className="mt-2 flex justify-between items-center text-[9px] text-gray-500 bg-black/20 p-1.5 rounded">
                <span>LIQ: <span className="text-gray-300">{(token.vSolInBondingCurve || 0).toFixed(1)} SOL</span></span>
                {rugCheck.warnings.length > 0 && (
                    <span className="text-yellow-500 flex items-center gap-1"><AlertTriangle size={8} /> Risk</span>
                )}
            </div>
        </div>
    );
});
StreamItem.displayName = 'StreamItem';

// Premium Card for Gem Vault
const GemItem = memo(({ token }: { token: TokenData }) => {
    return (
        <div className="p-3 mb-2 rounded border border-green-500/30 bg-green-500/5 hover:bg-green-500/10 hover:shadow-[0_0_15px_rgba(20,241,149,0.1)] transition-all">
            <div className="flex justify-between items-start mb-2">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center text-green-400">
                        <Diamond size={16} className="animate-pulse" />
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-green-400 flex items-center gap-1">
                            {token.symbol}
                            <span className="flex h-2 w-2 rounded-full bg-green-500 animate-ping"></span>
                        </h3>
                        <p className="text-[10px] text-green-500/70 font-medium">Potential Gem</p>
                    </div>
                </div>
                <div className="text-right">
                    <p className="text-[10px] font-mono text-green-300">
                        {new Date(token.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </p>
                </div>
            </div>
            <div className="flex justify-between items-center text-[10px] text-green-600 bg-green-900/10 p-2 rounded border border-green-500/10">
                <span className="font-bold">LIQUIDITY</span>
                <span className="font-mono text-green-300 text-xs">{(token.vSolInBondingCurve || 0).toFixed(1)} SOL</span>
            </div>
            <a href={`https://pump.fun/${token.mint}`} target="_blank" rel="noopener noreferrer" className="mt-2 block w-full py-1 text-center text-[10px] font-bold bg-green-500/10 hover:bg-green-500/20 text-green-400 rounded transition-colors">
                VIEW ON PUMP.FUN
            </a>
        </div>
    );
});
GemItem.displayName = 'GemItem';

interface LiveFeedProps {
    onTokenDetected: (token: TokenData) => void;
    isDemo?: boolean;
    isSimulating?: boolean;
    heliusKey?: string;
}

export default function LiveFeed({ onTokenDetected, isDemo = false, isSimulating = false, heliusKey = "" }: LiveFeedProps) {
    const [tokens, setTokens] = useState<TokenData[]>([]);
    const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "simulating">("connecting");
    const [paused, setPaused] = useState(false);
    const [lastError, setLastError] = useState<string>("");

    const wsRef = useRef<WebSocket | null>(null);
    const connectionTimeout = useRef<NodeJS.Timeout | null>(null);
    const simulationInterval = useRef<NodeJS.Timeout | null>(null);
    const processingQueue = useRef(false);
    const requestQueue = useRef<(() => Promise<any>)[]>([]);
    const processedSignatures = useRef<Set<string>>(new Set());

    // Use a Ref to hold the latest callback to avoid stale closures in WS effects
    const onTokenDetectedRef = useRef(onTokenDetected);
    useEffect(() => { onTokenDetectedRef.current = onTokenDetected; }, [onTokenDetected]);

    // Helius Connection Ref
    const heliusConnection = useRef(createConnection(heliusKey));
    useEffect(() => {
        if (heliusKey) {
            heliusConnection.current = createConnection(heliusKey);
        }
    }, [heliusKey]);

    const addToQueue = (task: () => Promise<any>) => {
        requestQueue.current.push(task);
        if (!processingQueue.current) processQueue();
    };

    const processQueue = async () => {
        if (processingQueue.current || requestQueue.current.length === 0) return;
        processingQueue.current = true;
        while (requestQueue.current.length > 0) {
            const task = requestQueue.current.shift();
            if (task) {
                try { await task(); } catch (e) { }
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        processingQueue.current = false;
    };

    // Categorize tokens for display
    const { gems, stream, junkyard } = useMemo(() => {
        const _gems: TokenData[] = [];
        const _stream: Array<{ token: TokenData, rugCheck: any }> = [];
        const _junkyard: Array<{ token: TokenData, reason: string }> = [];

        // Process only latest 60 tokens to keep UI snappy
        tokens.slice(0, 60).forEach(token => {
            const rugCheck = detectRug(token, 'medium');
            const liquidity = token.vSolInBondingCurve || 0;

            if (rugCheck.isRug) {
                _junkyard.push({ token, reason: rugCheck.reason || 'Rug Detected' });
            } else if (liquidity > 35 && rugCheck.warnings.length === 0) {
                // High quality
                _gems.push(token);
            } else {
                // Normal stream
                _stream.push({ token, rugCheck });
            }
        });

        return {
            gems: _gems.slice(0, 5), // Show max 5 gems
            stream: _stream.slice(0, 50), // Main feed
            junkyard: _junkyard.slice(0, 8) // Show max 8 trash items
        };
    }, [tokens]);

    // WebSocket & Simulation Logic
    const connectWs = () => {
        if (isSimulating) { setStatus("simulating"); return; }
        if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;

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
            const useHelius = heliusKey && heliusKey.includes('-');
            const url = useHelius ? `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}` : 'wss://pumpportal.fun/api/data';
            const ws = new WebSocket(url);
            wsRef.current = ws;

            ws.onopen = () => {
                if (connectionTimeout.current) clearTimeout(connectionTimeout.current);
                setStatus("connected");
                setLastError("");
                if (useHelius) {
                    ws.send(JSON.stringify({
                        jsonrpc: "2.0", id: 1, method: "logsSubscribe",
                        params: [{ mentions: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"] }, { commitment: "processed" }]
                    }));
                } else {
                    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
                }
            };

            ws.onmessage = async (event) => {
                if (paused) return;
                try {
                    const data = JSON.parse(event.data);
                    // Handle Helius Logs
                    if (useHelius && data.method === "logsNotification") {
                        const logs = data.params.result.value.logs as string[];
                        const signature = data.params.result.value.signature;
                        if (processedSignatures.current.has(signature)) return;
                        processedSignatures.current.add(signature);
                        // Cleanup set
                        if (processedSignatures.current.size > 500) {
                            const list = Array.from(processedSignatures.current);
                            processedSignatures.current = new Set(list.slice(250));
                        }

                        // Extract mint from logs
                        let mint: string | null = null;
                        for (const log of logs) {
                            const mintMatch = log.match(/mint: ([1-9A-HJ-NP-Za-km-z]{32,44})/i);
                            if (mintMatch && mintMatch[1]) { mint = mintMatch[1]; break; }
                        }

                        const createPatterns = ["Instruction: Create", "create", "Create", "initialize", "Initialize", "new_token", "NewToken"];
                        const isCreate = logs.some(log => createPatterns.some(pattern => log.includes(pattern)));

                        if (mint && isCreate) {
                            addToQueue(async () => {
                                const meta = await getTokenMetadata(mint!, heliusKey).catch(() => ({ name: "Unknown", symbol: "???" }));
                                const pump = await getPumpData(mint!, heliusConnection.current).catch(() => null);
                                if (!pump) return;
                                const newToken: TokenData = {
                                    mint: mint!, traderPublicKey: "Unknown", txType: "create",
                                    initialBuy: 0, bondingCurveKey: "", vTokensInBondingCurve: pump.vTokensInBondingCurve,
                                    vSolInBondingCurve: pump.vSolInBondingCurve, marketCapSol: pump.vSolInBondingCurve,
                                    name: meta.name || "Real Token", symbol: meta.symbol || "REAL", uri: meta.uri || "", timestamp: Date.now()
                                };
                                updateTokens(newToken);
                            });
                        }
                    }
                    // Handle PumpPortal
                    else if (data.mint) {
                        const vSol = data.vSolInBondingCurve ? data.vSolInBondingCurve / 1e9 : 0;
                        const newToken: TokenData = { ...data, vSolInBondingCurve: vSol, timestamp: Date.now(), marketCapSol: vSol };
                        updateTokens(newToken);
                    }
                } catch (e) { console.warn("WS Parse Error", e); }
            };

            ws.onclose = () => { if (!isSimulating) setStatus("disconnected"); };
            ws.onerror = () => { setLastError("WS Error"); setStatus("disconnected"); };
        } catch (err) { setLastError("WS Failed"); setStatus("disconnected"); }
    };

    const updateTokens = (token: TokenData) => {
        setTokens(prev => {
            if (prev.some(t => t.mint === token.mint)) return prev;
            return [token, ...prev].slice(0, 100);
        });
        onTokenDetectedRef.current(token);
    };

    // Simulation Effect
    useEffect(() => {
        if (isSimulating) {
            if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
            if (simulationInterval.current) clearInterval(simulationInterval.current);
            setStatus("simulating");
            simulationInterval.current = setInterval(() => {
                if (paused) return;
                const randomMint = "SIM" + Math.random().toString(36).substring(7).toUpperCase();
                const symbols = ["SOL", "PUMP", "MOON", "PEPE", "DOGE", "RUG", "SCAM", "GEM", "AI", "MAGA"];
                const randomSymbol = symbols[Math.floor(Math.random() * symbols.length)] + Math.floor(Math.random() * 99);
                const isRug = Math.random() < 0.3; // 30% rugs
                const isGem = Math.random() < 0.1; // 10% gems

                const newToken: TokenData = {
                    mint: randomMint, traderPublicKey: "SIM", txType: "create", initialBuy: 1, bondingCurveKey: "SIM",
                    vTokensInBondingCurve: 1000000000,
                    vSolInBondingCurve: isGem ? 45 + Math.random() * 20 : (isRug ? 30 + Math.random() : 32 + Math.random() * 5),
                    marketCapSol: 30, name: isRug ? "Rug Pull Coin" : isGem ? "Diamond Hands" : "Random Token",
                    symbol: randomSymbol, uri: "", timestamp: Date.now()
                };
                updateTokens(newToken);
            }, 2000);
        } else {
            if (simulationInterval.current) clearInterval(simulationInterval.current);
            connectWs();
        }
        return () => { if (simulationInterval.current) clearInterval(simulationInterval.current); };
    }, [isSimulating, heliusKey, paused]);

    const manualReconnect = () => {
        if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
        connectWs();
    };

    return (
        <div className="glass-panel p-4 h-[650px] flex flex-col animate-fade-in relative overflow-hidden">
            {/* Header */}
            <div className="flex justify-between items-center mb-4 z-10 border-b border-[#333] pb-2">
                <div>
                    <h2 className="text-xl font-bold glow-text flex items-center gap-2">
                        <Activity size={20} className="text-[var(--primary)]" />
                        <span className="hidden sm:inline">Scanner Feed</span>
                        <span className="sm:hidden">Feed</span>
                    </h2>
                    <div className="flex items-center gap-2 mt-1">
                        <span className={`w-2 h-2 rounded-full ${status === "connected" ? "bg-green-500 animate-pulse" : status === "simulating" ? "bg-blue-500 animate-pulse" : "bg-red-500"}`}></span>
                        <span className="text-[10px] text-gray-400 uppercase tracking-widest">{status}</span>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={() => setPaused(!paused)} className={`p-1.5 rounded border ${paused ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/50' : 'bg-[#222] text-gray-400 border-[#333]'}`}>
                        {paused ? <Play size={14} /> : <Pause size={14} />}
                    </button>
                    {!isSimulating && status === "disconnected" && (
                        <button onClick={manualReconnect} className="p-1.5 bg-[#222] rounded border border-[#333] text-gray-400 hover:text-white hover:rotate-180 transition-all duration-500">
                            <RefreshCw size={14} />
                        </button>
                    )}
                </div>
            </div>

            {/* Content Columns */}
            <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-3 overflow-hidden min-h-0 relative z-10">

                {/* 1. GEM VAULT (Hidden on small mobile if empty to save space, or shown first) */}
                <div className="flex flex-col min-h-0 bg-green-900/5 rounded-lg border border-green-500/10 order-2 md:order-1 h-32 md:h-auto">
                    <div className="p-2 border-b border-green-500/10 flex justify-between items-center bg-green-500/5 sticky top-0 bg-[#0a0a0a] z-10">
                        <span className="text-xs font-bold text-green-400 flex items-center gap-1">
                            <Diamond size={12} /> GEM VAULT
                        </span>
                        <span className="text-[10px] text-green-600 font-mono">{gems.length}</span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 custom-scrollbar space-y-2">
                        {gems.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-green-900/30">
                                <Diamond size={24} className="opacity-20 mb-1" />
                                <span className="text-[9px]">Scanning for Gems...</span>
                            </div>
                        ) : gems.map(t => <GemItem key={t.mint} token={t} />)}
                    </div>
                </div>

                {/* 2. THE STREAM (Main feed) */}
                <div className="flex flex-col min-h-0 bg-[#121212] rounded-lg border border-[#222] order-1 md:order-2 flex-grow">
                    <div className="p-2 border-b border-[#333] flex justify-between items-center bg-[#1a1a1a] sticky top-0 z-10">
                        <span className="text-xs font-bold text-blue-400 flex items-center gap-1">
                            <Activity size={12} /> LIVE STREAM
                        </span>
                        <span className="text-[10px] text-gray-600 font-mono">{stream.length}</span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
                        <div className="space-y-2">
                            {stream.map(item => <StreamItem key={item.token.mint} token={item.token} rugCheck={item.rugCheck} />)}
                        </div>
                    </div>
                </div>

                {/* 3. JUNKYARD */}
                <div className="flex flex-col min-h-0 bg-red-900/5 rounded-lg border border-red-500/10 order-3 h-32 md:h-auto">
                    <div className="p-2 border-b border-red-500/10 flex justify-between items-center bg-red-500/5 sticky top-0 bg-[#0a0a0a] z-10">
                        <span className="text-xs font-bold text-red-400 flex items-center gap-1">
                            <Trash2 size={12} /> INCINERATOR
                        </span>
                        <span className="text-[10px] text-red-600 font-mono">{junkyard.length}</span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
                        {junkyard.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-red-900/30">
                                <Trash2 size={24} className="opacity-20 mb-1" />
                                <span className="text-[9px]">Awaiting Garbage...</span>
                            </div>
                        ) : junkyard.map(item => <JunkItem key={item.token.mint} token={item.token} reason={item.reason} />)}
                    </div>
                </div>

            </div>
            {/* Background Effects */}
            <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-[var(--primary)]/5 blur-[80px] rounded-full pointer-events-none"></div>
            <div className="absolute -top-10 -left-10 w-40 h-40 bg-purple-500/5 blur-[80px] rounded-full pointer-events-none"></div>
        </div>
    );
}
