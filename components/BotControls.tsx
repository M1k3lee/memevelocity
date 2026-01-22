"use client";

import React, { useState, useEffect } from 'react';
import { Play, Square, Settings, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

export interface AdvancedConfig {
    minLiquidity: number;       // SOL
    maxLiquidity: number;       // SOL
    minVolume: number;          // SOL (24h)
    minHolderCount: number;
    maxTop10: number;           // %
    maxDev: number;             // %
    minBondingCurve: number;    // %
    maxBondingCurve: number;    // %
    minVelocity: number;        // SOL/min
    rugCheckStrictness: "lenient" | "standard" | "strict";
    requireSocials: boolean;
    avoidSnipers: boolean;
    slippage: number;
}

interface BotConfig {
    amount: number;
    takeProfit: number;
    stopLoss: number;
    mode: "safe" | "medium" | "high" | "scalp" | "first" | "custom";
    isRunning: boolean;
    isDemo: boolean;
    isSimulating: boolean;
    heliusKey: string;
    maxConcurrentTrades: number;
    dynamicSizing: boolean;
    advanced: AdvancedConfig;
}

interface BotControlsProps {
    onConfigChange: (config: BotConfig) => void;
    walletConnected: boolean;
    realBalance?: number;
}

export default function BotControls({ onConfigChange, walletConnected, realBalance = 0 }: BotControlsProps) {
    const [isRunning, setIsRunning] = useState(false);
    const [mode, setMode] = useState<"safe" | "medium" | "high" | "scalp" | "first" | "custom">("safe");
    const [amount, setAmount] = useState(0.01);
    const [takeProfit, setTakeProfit] = useState(20);
    const [stopLoss, setStopLoss] = useState(10);
    const [isDemo, setIsDemo] = useState(false);
    const [isSimulating, setIsSimulating] = useState(false);
    const [maxConcurrentTrades, setMaxConcurrentTrades] = useState(1);
    const [dynamicSizing, setDynamicSizing] = useState(true);
    const [activeTab, setActiveTab] = useState<'basic' | 'advanced'>('basic');
    const [advancedConfig, setAdvancedConfig] = useState<AdvancedConfig>({
        minLiquidity: 10,
        maxLiquidity: 1000,
        minVolume: 5,
        minHolderCount: 100,
        maxTop10: 50,
        maxDev: 5,
        minBondingCurve: 5,
        maxBondingCurve: 40,
        minVelocity: 0.5,
        rugCheckStrictness: "strict",
        requireSocials: false,
        avoidSnipers: true,
        slippage: 20
    });

    // Update parent whenever config changes
    useEffect(() => {
        // Get Helius key from localStorage (managed in WalletManager)
        const heliusKey = localStorage.getItem('helius_api_key') || '';

        onConfigChange({
            amount,
            takeProfit,
            stopLoss,
            mode,
            isRunning,
            isDemo,
            isSimulating,
            heliusKey,
            maxConcurrentTrades,
            dynamicSizing,
            advanced: advancedConfig
        });
    }, [amount, takeProfit, stopLoss, mode, isRunning, isDemo, isSimulating, maxConcurrentTrades, dynamicSizing, advancedConfig]);

    const setPreset = (preset: "safe" | "medium" | "high" | "scalp" | "first" | "custom") => {
        setMode(preset);
        if (preset === "safe") {
            setAmount(0.01);
            setTakeProfit(20);
            setStopLoss(10);
            setAdvancedConfig({
                minLiquidity: 10,
                maxLiquidity: 1000,
                minVolume: 5,
                minHolderCount: 100,
                maxTop10: 50,
                maxDev: 5,
                minBondingCurve: 5,
                maxBondingCurve: 40,
                minVelocity: 0.5,
                rugCheckStrictness: "strict",
                requireSocials: false,
                avoidSnipers: true,
                slippage: 15
            });
        } else if (preset === "medium") {
            setAmount(0.02);
            setTakeProfit(50);
            setStopLoss(15);
            setAdvancedConfig({
                minLiquidity: 5,
                maxLiquidity: 2000,
                minVolume: 2,
                minHolderCount: 50,
                maxTop10: 60,
                maxDev: 10,
                minBondingCurve: 2,
                maxBondingCurve: 60,
                minVelocity: 0.2,
                rugCheckStrictness: "standard",
                requireSocials: false,
                avoidSnipers: false,
                slippage: 20
            });
        } else if (preset === "high") {
            setAmount(0.03);
            setTakeProfit(100);
            setStopLoss(30);
            setAdvancedConfig({
                minLiquidity: 1,
                maxLiquidity: 5000,
                minVolume: 1,
                minHolderCount: 10,
                maxTop10: 80,
                maxDev: 20,
                minBondingCurve: 0,
                maxBondingCurve: 80,
                minVelocity: 0,
                rugCheckStrictness: "lenient",
                requireSocials: false,
                avoidSnipers: false,
                slippage: 25
            });
        } else if (preset === "scalp") {
            setAmount(0.01);
            setTakeProfit(50);
            setStopLoss(10);
            setAdvancedConfig({
                minLiquidity: 8,
                maxLiquidity: 1000,
                minVolume: 10,
                minHolderCount: 50,
                maxTop10: 60,
                maxDev: 10,
                minBondingCurve: 10,
                maxBondingCurve: 70,
                minVelocity: 1,
                rugCheckStrictness: "standard",
                requireSocials: false,
                avoidSnipers: true,
                slippage: 30
            });
        } else if (preset === "first") {
            setAmount(0.01);
            setTakeProfit(30);
            setStopLoss(8);
            setAdvancedConfig({
                minLiquidity: 1,
                maxLiquidity: 500,
                minVolume: 0,
                minHolderCount: 0,
                maxTop10: 90,
                maxDev: 50,
                minBondingCurve: 0,
                maxBondingCurve: 10,
                minVelocity: 0,
                rugCheckStrictness: "lenient",
                requireSocials: false,
                avoidSnipers: false,
                slippage: 40
            });
        }
    };

    const toggleRun = () => {
        if (!walletConnected && !isDemo) {
            alert("Please connect a wallet first.");
            return;
        }
        setIsRunning(!isRunning);
    };

    return (
        <div className="glass-panel p-6 w-full animate-fade-in delay-100">
            <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold glow-text flex items-center gap-2">
                    <Settings size={20} /> Bot Configuration
                </h2>
                {isRunning && <span className="text-[var(--primary)] text-sm animate-pulse">● Live & Scanning</span>}
            </div>

            <div className="mb-4">
                <label className="text-gray-400 text-sm mb-2 block">Trading Strategy</label>
                <div className="grid grid-cols-2 gap-2">
                    <button
                        onClick={() => setPreset("safe")}
                        className={`p-3 rounded border transition-all ${mode === "safe" ? "border-[var(--success)] bg-[rgba(20,241,149,0.1)] text-[var(--success)]" : "border-[#333] hover:border-[#555] text-gray-400"}`}
                    >
                        <div className="font-bold whitespace-nowrap">Safe-ish</div>
                        <div className="text-[10px] opacity-70">Score: ≥65 | Strict Entry</div>
                    </button>
                    <button
                        onClick={() => setPreset("medium")}
                        className={`p-3 rounded border transition-all ${mode === "medium" ? "border-[var(--warning)] bg-[rgba(255,204,0,0.1)] text-[var(--warning)]" : "border-[#333] hover:border-[#555] text-gray-400"}`}
                    >
                        <div className="font-bold">Medium</div>
                        <div className="text-[10px] opacity-70">Score: ≥50 | Balanced</div>
                    </button>
                    <button
                        onClick={() => setPreset("high")}
                        className={`p-3 rounded border transition-all ${mode === "high" ? "border-[var(--danger)] bg-[rgba(255,0,85,0.1)] text-[var(--danger)]" : "border-[#333] hover:border-[#555] text-gray-400"}`}
                    >
                        <div className="font-bold">High Risk</div>
                        <div className="text-[10px] opacity-70">Score: ≥30 | Aggressive</div>
                    </button>
                    <button
                        onClick={() => setPreset("scalp")}
                        className={`p-3 rounded border transition-all ${mode === "scalp" ? "border-[#00d4ff] bg-[rgba(0,212,255,0.1)] text-[#00d4ff]" : "border-[#333] hover:border-[#555] text-gray-400"}`}
                    >
                        <div className="font-bold">⚡ SCALP</div>
                        <div className="text-[10px] opacity-70">Momentum | Quick Exits</div>
                    </button>
                    <button
                        onClick={() => setPreset("first")}
                        className={`p-3 rounded border transition-all ${mode === "first" ? "border-[#ff00ff] bg-[rgba(255,0,255,0.1)] text-[#ff00ff]" : "border-[#333] hover:border-[#555] text-gray-400"}`}
                    >
                        <div className="font-bold">🚀 FIRST</div>
                        <div className="text-[10px] opacity-70">6s exit | Sniper Mode</div>
                    </button>
                    <button
                        onClick={() => setPreset("custom")}
                        className={`p-3 rounded border transition-all ${mode === "custom" ? "border-[#888] bg-[rgba(136,136,136,0.1)] text-[#888]" : "border-[#333] hover:border-[#555] text-gray-400"}`}
                    >
                        <div className="font-bold">Custom</div>
                        <div className="text-[10px] opacity-70">Manual control</div>
                    </button>
                </div>
            </div>

            <div className="flex items-center justify-between mb-6 bg-[#1a1a1a] p-3 rounded border border-[#333]">
                <div className="flex flex-col">
                    <span className="font-bold text-white flex items-center gap-2">Paper Trading</span>
                    <span className="text-xs text-gray-400">Fake balance trade (Zero Risk)</span>
                </div>
                <button
                    onClick={() => setIsDemo(!isDemo)}
                    className={`text-xs px-3 py-1 rounded transition-colors ${isDemo ? 'bg-blue-600 text-white' : 'bg-[#333] text-gray-400'}`}
                >
                    {isDemo ? "Active" : "Disabled"}
                </button>
            </div>

            <div className="flex items-center justify-between mb-6 bg-[#1a1a1a] p-3 rounded border border-[#333]">
                <div className="flex flex-col">
                    <span className="font-bold text-white flex items-center gap-2">Market Data</span>
                    <span className="text-xs text-gray-400">Use live tokens vs simulator</span>
                </div>
                <button
                    onClick={() => setIsSimulating(!isSimulating)}
                    className={`text-xs px-3 py-1 rounded transition-colors ${!isSimulating ? 'bg-green-600 text-white' : 'bg-purple-600 text-white'}`}
                >
                    {!isSimulating ? "Live Market" : "Simulated"}
                </button>
            </div>

            <div className="flex mb-6 border-b border-[#333]">
                <button
                    onClick={() => setActiveTab('basic')}
                    className={`flex-1 py-2 text-sm font-bold border-b-2 transition-colors ${activeTab === 'basic' ? 'border-[var(--primary)] text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                >
                    Basic Settings
                </button>
                <button
                    onClick={() => setActiveTab('advanced')}
                    className={`flex-1 py-2 text-sm font-bold border-b-2 transition-colors ${activeTab === 'advanced' ? 'border-[var(--primary)] text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                >
                    Advanced Filters
                </button>
            </div>

            {activeTab === 'basic' ? (
                <div className="space-y-4 mb-8">
                    <div>
                        <label className="text-gray-400 text-sm flex justify-between">
                            Trade Amount (SOL)
                            <span className="text-white">{amount} SOL</span>
                        </label>
                        <input
                            type="range" min="0.01" max="1" step="0.01"
                            value={amount}
                            onChange={(e) => setAmount(parseFloat(e.target.value))}
                            className={`w-full h-2 rounded-lg appearance-none cursor-pointer mt-2 ${(amount + (isDemo ? 0 : 0.05)) > (isDemo ? 1000 : realBalance) ? 'bg-red-900' : 'bg-[#222]'}`}
                        />
                        {amount + 0.05 > realBalance && !isDemo && (
                            <p className="text-[10px] text-red-500 mt-1 flex items-center gap-1">
                                <AlertTriangle size={10} /> Insufficient balance (need ~0.05 SOL reserve for fees).
                            </p>
                        )}
                    </div>

                    <div className="flex gap-4">
                        <div className="flex-1">
                            <label className="text-gray-400 text-sm">Take Profit (%)</label>
                            <input
                                type="number"
                                value={takeProfit}
                                onChange={(e) => setTakeProfit(parseInt(e.target.value))}
                                className="w-full bg-[#121212] border border-[#222] rounded p-2 text-white mt-1"
                            />
                        </div>
                        <div className="flex-1">
                            <label className="text-gray-400 text-sm">Stop Loss (%)</label>
                            <input
                                type="number"
                                value={stopLoss}
                                onChange={(e) => setStopLoss(parseInt(e.target.value))}
                                className="w-full bg-[#121212] border border-[#222] rounded p-2 text-white mt-1"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="text-gray-400 text-sm flex justify-between">
                            Max Concurrent Trades
                            <span className="text-white">{maxConcurrentTrades}</span>
                        </label>
                        <input
                            type="range" min="1" max="10" step="1"
                            value={maxConcurrentTrades}
                            onChange={(e) => setMaxConcurrentTrades(parseInt(e.target.value))}
                            className="w-full h-2 bg-[#222] rounded-lg appearance-none cursor-pointer mt-2"
                        />
                    </div>

                    <div className="flex items-center justify-between bg-[#1a1a1a] p-3 rounded border border-[#333] mt-4">
                        <div className="flex flex-col">
                            <span className="font-bold text-white text-sm">Dynamic Position Sizing</span>
                            <span className="text-[10px] text-gray-400">Increase size on high-confidence trades</span>
                        </div>
                        <button
                            onClick={() => setDynamicSizing(!dynamicSizing)}
                            className={`text-xs px-3 py-1 rounded transition-colors ${dynamicSizing ? 'bg-purple-600 text-white' : 'bg-[#333] text-gray-400'}`}
                        >
                            {dynamicSizing ? "ON" : "OFF"}
                        </button>
                    </div>
                </div>
            ) : (
                <div className="space-y-4 mb-8">
                    <div className="bg-[#1a1a1a] p-4 rounded border border-[#333]">
                        <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                            <AlertTriangle size={14} className="text-yellow-500" /> Rug Protection
                        </h3>
                        <div className="mb-3">
                            <label className="text-gray-400 text-xs flex justify-between mb-1">
                                Rug Check Strictness
                                <span className="text-white capitalize">{advancedConfig.rugCheckStrictness}</span>
                            </label>
                            <div className="flex gap-2">
                                {(['lenient', 'standard', 'strict'] as const).map((s) => (
                                    <button
                                        key={s}
                                        onClick={() => setAdvancedConfig(prev => ({ ...prev, rugCheckStrictness: s }))}
                                        className={`flex-1 py-1 text-xs rounded border ${advancedConfig.rugCheckStrictness === s ? 'bg-blue-900/30 border-blue-500 text-blue-400' : 'bg-[#222] border-[#333] text-gray-500'}`}
                                    >
                                        {s}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="flex justify-between items-center">
                            <label className="text-gray-400 text-xs">Avoid Snipers</label>
                            <button
                                onClick={() => setAdvancedConfig(prev => ({ ...prev, avoidSnipers: !prev.avoidSnipers }))}
                                className={`w-10 h-5 rounded-full relative transition-colors ${advancedConfig.avoidSnipers ? 'bg-green-600' : 'bg-[#333]'}`}
                            >
                                <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full transition-transform ${advancedConfig.avoidSnipers ? 'translate-x-5' : ''}`} />
                            </button>
                        </div>
                    </div>

                    <div className="bg-[#1a1a1a] p-4 rounded border border-[#333]">
                        <h3 className="text-sm font-bold text-white mb-3">Execution Settings</h3>
                        <div>
                            <label className="text-gray-400 text-xs flex justify-between mb-1">
                                Max Slippage (%)
                                <span className="text-white font-bold">{advancedConfig.slippage}%</span>
                            </label>
                            <input
                                type="range" min="1" max="99" step="1"
                                value={advancedConfig.slippage}
                                onChange={(e) => setAdvancedConfig(prev => ({ ...prev, slippage: parseInt(e.target.value) }))}
                                className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                            />
                            <p className="text-[9px] text-gray-500 mt-1">Increase for fast tokens to avoid slippage errors.</p>
                        </div>
                    </div>

                    <div className="bg-[#1a1a1a] p-4 rounded border border-[#333]">
                        <h3 className="text-sm font-bold text-white mb-3">Bonding Curve & Liquidity</h3>
                        <div className="grid grid-cols-2 gap-3 mb-3">
                            <input
                                type="number" placeholder="Min Liquidity"
                                value={advancedConfig.minLiquidity}
                                onChange={(e) => setAdvancedConfig(prev => ({ ...prev, minLiquidity: parseFloat(e.target.value) }))}
                                className="w-full bg-[#121212] border border-[#222] rounded p-2 text-white text-xs"
                            />
                            <input
                                type="number" placeholder="Min Volume"
                                value={advancedConfig.minVolume}
                                onChange={(e) => setAdvancedConfig(prev => ({ ...prev, minVolume: parseFloat(e.target.value) }))}
                                className="w-full bg-[#121212] border border-[#222] rounded p-2 text-white text-xs"
                            />
                        </div>
                        <div className="flex gap-2 items-center">
                            <input
                                type="number" value={advancedConfig.minBondingCurve}
                                onChange={(e) => setAdvancedConfig(prev => ({ ...prev, minBondingCurve: parseFloat(e.target.value) }))}
                                className="w-16 bg-[#121212] border border-[#222] rounded p-2 text-white text-xs"
                            />
                            <span className="text-gray-500 text-xs">to</span>
                            <input
                                type="number" value={advancedConfig.maxBondingCurve}
                                onChange={(e) => setAdvancedConfig(prev => ({ ...prev, maxBondingCurve: parseFloat(e.target.value) }))}
                                className="w-16 bg-[#121212] border border-[#222] rounded p-2 text-white text-xs"
                            />
                        </div>
                    </div>
                </div>
            )}

            <button
                onClick={toggleRun}
                className={`w-full py-4 rounded-lg font-bold text-lg flex justify-center items-center gap-2 transition-all shadow-lg mt-4 ${isRunning ? "bg-red-500/20 text-red-500 border border-red-500/50" : "btn-primary"}`}
            >
                {isRunning ? <><Square fill="currentColor" size={18} /> STOP BOT</> : <><Play fill="currentColor" size={18} /> {isDemo ? "START PAPER TRADING" : "START LIVE TRADING"}</>}
            </button>

            {!walletConnected && !isDemo && (
                <div className="mt-4 p-2 bg-yellow-500/10 text-yellow-500 text-xs rounded border border-yellow-500/20 flex gap-2 items-center">
                    <AlertTriangle size={12} /> Connect wallet to start live trading
                </div>
            )}
        </div>
    );
}
