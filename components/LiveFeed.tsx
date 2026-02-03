"use client";

import React, { useEffect, useState, useRef, memo, useMemo } from 'react';
import { Activity, ExternalLink, RefreshCw, Zap, AlertTriangle, Pause, Play, Trash2, Diamond, Terminal, ShieldCheck, ShieldAlert } from 'lucide-react';
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

// 🗂️ ITEM COMPONENTS - Redesigned for Vertical Space
const JunkItem = memo(({ token, reason }: { token: TokenData, reason: string }) => (
    <div className="flex items-center justify-between p-3 mb-2 bg-red-500/5 border border-red-500/10 rounded group hover:bg-red-500/10 transition-all">
        <div className="flex items-center gap-3 overflow-hidden">
            <div className="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center text-red-500/40 group-hover:text-red-500 transition-colors">
                <Trash2 size={14} />
            </div>
            <div className="flex flex-col overflow-hidden">
                <span className="text-xs font-bold text-red-400 truncate">{token.symbol}</span>
                <span className="text-[10px] text-red-500/60 truncate">{reason}</span>
            </div>
        </div>
        <div className="text-right flex flex-col items-end">
            <span className="text-[10px] font-mono text-red-900/50">{new Date(token.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })}</span>
            <a href={`https://pump.fun/${token.mint}`} target="_blank" rel="noopener noreferrer" className="text-[9px] text-red-500/30 hover:text-red-500"><ExternalLink size={10} /></a>
        </div>
    </div>
));

const StreamItem = memo(({ token, rugCheck }: { token: TokenData, rugCheck: any }) => (
    <div className="p-4 mb-3 rounded-xl border border-[#222] bg-[#1a1a1a]/40 hover:border-blue-500/30 hover:bg-[#1a1a1a]/60 transition-all group">
        <div className="flex justify-between items-start mb-2">
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-400 group-hover:scale-110 transition-transform">
                    <Zap size={18} />
                </div>
                <div>
                    <h3 className="text-sm font-bold text-gray-100">{token.symbol}</h3>
                    <p className="text-[10px] text-gray-500 truncate max-w-[120px]">{token.name}</p>
                </div>
            </div>
            <div className="text-right">
                <span className="text-[10px] font-mono text-gray-500 block mb-1">
                    {new Date(token.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <a href={`https://pump.fun/${token.mint}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[10px] text-blue-500/70 hover:text-blue-400">
                    Explorer <ExternalLink size={10} />
                </a>
            </div>
        </div>
        <div className="flex gap-4 mt-3">
            <div className="flex-1 bg-black/30 p-2 rounded-lg border border-[#222]">
                <span className="text-[9px] text-gray-600 block uppercase font-bold tracking-tighter">Liquidity</span>
                <span className="text-xs font-mono text-blue-400">{(token.vSolInBondingCurve || 0).toFixed(2)} SOL</span>
            </div>
            <div className="flex-1 bg-black/30 p-2 rounded-lg border border-[#333]/30">
                <span className="text-[9px] text-gray-600 block uppercase font-bold tracking-tighter">Risk Score</span>
                <span className={`text-xs font-mono ${rugCheck.warnings.length === 0 ? 'text-green-500' : 'text-yellow-500'}`}>
                    {rugCheck.warnings.length === 0 ? 'LOW' : 'MEDIUM'}
                </span>
            </div>
        </div>
    </div>
));

const GemItem = memo(({ token }: { token: TokenData }) => (
    <div className="p-5 mb-4 rounded-2xl border border-green-500/20 bg-green-500/5 hover:bg-green-500/10 hover:shadow-[0_0_30px_rgba(20,241,149,0.05)] transition-all group relative overflow-hidden">
        <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
            <Diamond size={60} />
        </div>
        <div className="flex justify-between items-center mb-4 relative z-10">
            <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 shadow-[0_0_15px_rgba(34,197,94,0.3)]">
                    <Diamond size={24} className="animate-pulse" />
                </div>
                <div>
                    <div className="flex items-center gap-2">
                        <h3 className="text-lg font-black text-green-400 tracking-tight">{token.symbol}</h3>
                        <span className="flex h-2 w-2 rounded-full bg-green-500 animate-ping"></span>
                    </div>
                    <p className="text-xs text-green-500/60 font-medium">Verified Liquid Premium</p>
                </div>
            </div>
            <div className="text-right text-[10px] font-mono text-green-300/50">
                {new Date(token.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-4 relative z-10">
            <div className="bg-green-500/10 p-3 rounded-xl border border-green-500/10">
                <span className="text-[10px] text-green-700 block uppercase font-bold">Reserves</span>
                <span className="text-sm font-mono text-green-400 font-bold">{(token.vSolInBondingCurve || 0).toFixed(2)} SOL</span>
            </div>
            <div className="bg-green-500/10 p-3 rounded-xl border border-green-500/10 flex flex-col justify-center items-center">
                <ShieldCheck size={18} className="text-green-500 mb-1" />
                <span className="text-[9px] text-green-500 font-bold">CONTRACT SAFE</span>
            </div>
        </div>
        <a href={`https://pump.fun/${token.mint}`} target="_blank" rel="noopener noreferrer" className="block w-full py-2.5 text-center text-xs font-black bg-green-500 text-black rounded-xl hover:bg-green-400 transition-colors relative z-10 shadow-lg shadow-green-500/20">
            TRADE ON PUMP.FUN
        </a>
    </div>
));

interface LiveFeedProps {
    onTokenDetected: (token: TokenData) => void;
    isDemo?: boolean;
    isSimulating?: boolean;
    heliusKey?: string;
}

export default function LiveFeed({ onTokenDetected, isDemo = false, isSimulating = false, heliusKey = "" }: LiveFeedProps) {
    const [tokens, setTokens] = useState<TokenData[]>([]);
    const [analysisLog, setAnalysisLog] = useState<{ id: string, msg: string, type: 'gem' | 'junk' | 'stream' }[]>([]);
    const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "simulating">("connecting");
    const [paused, setPaused] = useState(false);
    const [lastError, setLastError] = useState<string>("");

    const wsRef = useRef<WebSocket | null>(null);
    const simulationInterval = useRef<NodeJS.Timeout | null>(null);
    const processedSignatures = useRef<Set<string>>(new Set());
    const onTokenDetectedRef = useRef(onTokenDetected);

    // Auto-scroll logic for log
    const logEndRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }, [analysisLog]);

    useEffect(() => { onTokenDetectedRef.current = onTokenDetected; }, [onTokenDetected]);

    // Categorize
    const { gems, stream, junkyard } = useMemo(() => {
        const _gems: TokenData[] = [];
        const _stream: Array<{ token: TokenData, rugCheck: any }> = [];
        const _junkyard: Array<{ token: TokenData, reason: string }> = [];

        tokens.slice(0, 100).forEach(token => {
            const rugCheck = detectRug(token, 'medium');
            if (rugCheck.isRug) _junkyard.push({ token, reason: rugCheck.reason || 'Rug Detected' });
            else if ((token.vSolInBondingCurve || 0) > 35 && rugCheck.warnings.length === 0) _gems.push(token);
            else _stream.push({ token, rugCheck });
        });

        return { gems: _gems.slice(0, 8), stream: _stream.slice(0, 40), junkyard: _junkyard.slice(0, 15) };
    }, [tokens]);

    // WebSocket logic
    const connectWs = () => {
        if (isSimulating) { setStatus("simulating"); return; }
        if (wsRef.current?.readyState === WebSocket.OPEN) return;

        setStatus("connecting");
        try {
            const url = (heliusKey && heliusKey.includes('-')) ? `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}` : 'wss://pumpportal.fun/api/data';
            const ws = new WebSocket(url);
            wsRef.current = ws;

            ws.onopen = () => {
                setStatus("connected");
                ws.send(JSON.stringify({ method: "subscribeNewToken" }));
            };

            ws.onmessage = async (event) => {
                if (paused) return;
                try {
                    const data = JSON.parse(event.data);
                    if (data.mint) {
                        const vSol = data.vSolInBondingCurve ? data.vSolInBondingCurve / 1e9 : 0;
                        const token: TokenData = { ...data, vSolInBondingCurve: vSol, timestamp: Date.now(), marketCapSol: vSol };
                        processNewToken(token);
                    }
                } catch (e) { }
            };
            ws.onclose = () => setStatus("disconnected");
            ws.onerror = () => setStatus("disconnected");
        } catch (err) { setStatus("disconnected"); }
    };

    const processNewToken = (token: TokenData) => {
        const rugCheck = detectRug(token, 'medium');
        let type: 'gem' | 'junk' | 'stream' = 'stream';
        let detail = `New Token Found: ${token.symbol}`;

        if (rugCheck.isRug) {
            type = 'junk';
            detail = `🚩 INCINERATED: ${token.symbol} - ${rugCheck.reason}`;
        } else if ((token.vSolInBondingCurve || 0) > 35) {
            type = 'gem';
            detail = `💎 GEM DETECTED: ${token.symbol} - High Liquidity (${token.vSolInBondingCurve.toFixed(1)} SOL)`;
        }

        setAnalysisLog(prev => [...prev, { id: Math.random().toString(), msg: detail, type }].slice(-50));
        setTokens(prev => [token, ...prev.filter(t => t.mint !== token.mint)].slice(0, 150));
        onTokenDetectedRef.current(token);
    };

    useEffect(() => {
        if (isSimulating) {
            setStatus("simulating");
            simulationInterval.current = setInterval(() => {
                if (paused) return;
                const isGem = Math.random() < 0.1;
                const isRug = Math.random() < 0.3;
                const token: TokenData = {
                    mint: "SIM" + Math.random().toString(36).substring(7), traderPublicKey: "SIM", txType: "create",
                    initialBuy: 1, bondingCurveKey: "SIM", vTokensInBondingCurve: 1e9,
                    vSolInBondingCurve: isGem ? 45 : (isRug ? 30.1 : 31), marketCapSol: 30,
                    name: isRug ? "Rug Pull Coin" : isGem ? "Diamond G" : "Standard Token",
                    symbol: (isRug ? "RUG" : isGem ? "GEM" : "TOK") + Math.floor(Math.random() * 99), uri: "", timestamp: Date.now()
                };
                processNewToken(token);
            }, 3000);
        } else connectWs();
        return () => { if (simulationInterval.current) clearInterval(simulationInterval.current); };
    }, [isSimulating, paused]);

    return (
        <div className="flex flex-col gap-6 animate-fade-in h-[1200px]">

            {/* 🖥️ TOP: ANALYSIS CONSOLE (Real-time tracking of WHY tokens are sorted) */}
            <div className="glass-panel p-0 overflow-hidden border-[#333] shadow-2xl shrink-0">
                <div className="bg-[#1a1a1a] px-4 py-2 border-b border-[#333] flex justify-between items-center">
                    <div className="flex items-center gap-2">
                        <Terminal size={14} className="text-[var(--primary)]" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">Market Intelligence Terminal</span>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                            <span className={`w-1.5 h-1.5 rounded-full ${status === 'connected' ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
                            <span className="text-[9px] text-gray-500 font-mono">{status.toUpperCase()}</span>
                        </div>
                        <button onClick={() => setPaused(!paused)} className="hover:text-white text-gray-500 transition-colors">
                            {paused ? <Play size={12} /> : <Pause size={12} />}
                        </button>
                    </div>
                </div>
                <div className="h-44 overflow-y-auto p-3 font-mono text-[10px] bg-[#0c0c0c] custom-scrollbar">
                    {analysisLog.length === 0 ? (
                        <div className="text-gray-700 italic">Waiting for market activity...</div>
                    ) : (
                        analysisLog.map(log => (
                            <div key={log.id} className={`mb-1 flex gap-2 ${log.type === 'gem' ? 'text-green-400' : log.type === 'junk' ? 'text-red-500' : 'text-blue-400 opacity-80'}`}>
                                <span className="text-gray-600">[{new Date().toLocaleTimeString([], { hour12: false })}]</span>
                                <span className="font-bold">{log.msg}</span>
                            </div>
                        ))
                    )}
                    <div ref={logEndRef} />
                </div>
            </div>

            {/* 📦 VERTICAL STACK (Bigger Boxes Below) */}
            <div className="flex-1 flex flex-col gap-8 overflow-y-auto px-1 custom-scrollbar pb-10">

                {/* 💎 1. GEM VAULT (The High Confidence Plays) */}
                <div className="flex flex-col gap-4 animate-slide-in">
                    <div className="flex items-center justify-between sticky top-0 bg-[#0a0a0a] z-20 py-2 border-b border-green-500/20">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-green-500/20 rounded-lg text-green-400">
                                <Diamond size={18} />
                            </div>
                            <h2 className="text-lg font-black uppercase tracking-tighter text-gray-100 italic">Gem Vault</h2>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] text-green-500/50 font-mono">CONFIRMED</span>
                            <span className="bg-green-500 text-black text-[10px] px-2 py-0.5 rounded font-black">{gems.length}</span>
                        </div>
                    </div>
                    <div className="flex flex-col gap-3 min-h-[100px]">
                        {gems.length === 0 ? (
                            <div className="p-8 border-2 border-dashed border-[#1a1a1a] rounded-3xl flex flex-col items-center justify-center text-gray-700">
                                <Diamond size={32} className="opacity-10 mb-2 animate-bounce" />
                                <span className="text-[10px] uppercase font-black tracking-widest opacity-30">Locking onto Liquidity...</span>
                            </div>
                        ) : gems.map(t => <GemItem key={t.mint} token={t} />)}
                    </div>
                </div>

                {/* 🌊 2. LIVE DISCOVERY STREAM (Main Market Flow) */}
                <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between sticky top-0 bg-[#0a0a0a] z-20 py-2 border-b border-blue-500/20">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-blue-500/20 rounded-lg text-blue-400">
                                <Activity size={18} />
                            </div>
                            <h2 className="text-lg font-black uppercase tracking-tighter text-gray-100">Live Stream</h2>
                        </div>
                        <span className="text-[10px] text-blue-500/50 font-mono">{stream.length} RECENT</span>
                    </div>
                    <div className="flex flex-col gap-2">
                        {stream.map(item => <StreamItem key={item.token.mint} token={item.token} rugCheck={item.rugCheck} />)}
                    </div>
                </div>

                {/* 🚨 3. INCINERATOR (Safety First) */}
                <div className="flex flex-col gap-4 opacity-70 hover:opacity-100 transition-opacity">
                    <div className="flex items-center justify-between sticky top-0 bg-[#0a0a0a] z-20 py-2 border-b border-red-500/20">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-red-500/20 rounded-lg text-red-500">
                                <ShieldAlert size={18} />
                            </div>
                            <h2 className="text-lg font-black uppercase tracking-tighter text-gray-100">Incinerator</h2>
                        </div>
                        <span className="text-[10px] text-red-500/50 font-mono">AUTOMATED BLOCK</span>
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                        {junkyard.map(item => <JunkItem key={item.token.mint} token={item.token} reason={item.reason} />)}
                    </div>
                </div>

            </div>

            {/* Background Effects */}
            <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-[var(--primary)]/5 blur-[80px] rounded-full pointer-events-none"></div>
            <div className="absolute -top-10 -left-10 w-40 h-40 bg-purple-500/5 blur-[80px] rounded-full pointer-events-none"></div>
        </div>
    );
}
