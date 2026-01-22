"use client";

import React from 'react';
import { Wallet, TrendingUp, TrendingDown, Target } from 'lucide-react';

interface DashboardStatsProps {
    realBalance: number;
    demoBalance: number;
    isDemo: boolean;
    stats: {
        totalProfit: number;
        wins: number;
        losses: number;
    };
    heliusKey?: string;
}

export default function DashboardStats({ realBalance, demoBalance, isDemo, stats, heliusKey }: DashboardStatsProps) {
    const currentBalance = isDemo ? demoBalance : realBalance;
    const winRate = (stats.wins + stats.losses) > 0
        ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1)
        : 0;

    const hasHelius = heliusKey && heliusKey.length > 20;

    return (
        <div className="grid grid-cols-4 gap-4 mb-6 animate-fade-in">
            {/* Balance Card */}
            <div className="glass-panel p-4 flex flex-col justify-between relative overflow-hidden group">
                <div className="absolute -right-4 -top-4 bg-[var(--primary)]/10 w-24 h-24 rounded-full blur-2xl group-hover:bg-[var(--primary)]/20 transition-all"></div>
                <div className="flex items-center gap-2 text-gray-400 mb-1">
                    <Wallet size={16} />
                    <span className="text-xs uppercase tracking-wider font-semibold">
                        {isDemo ? "Simulated Balance" : "Wallet Balance"}
                    </span>
                </div>
                <div>
                    <span className="text-3xl font-bold text-white tracking-tight">{currentBalance.toFixed(4)}</span>
                    <span className="text-sm text-[var(--primary)] ml-1">SOL</span>
                </div>
                {isDemo && <div className="text-[10px] text-blue-400 mt-1">Paper Trading Active</div>}
            </div>

            {/* PnL Card */}
            <div className="glass-panel p-4 flex flex-col justify-between relative overflow-hidden">
                <div className="absolute -right-4 -top-4 bg-[var(--secondary)]/10 w-24 h-24 rounded-full blur-2xl"></div>
                <div className="flex items-center gap-2 text-gray-400 mb-1">
                    <TrendingUp size={16} />
                    <span className="text-xs uppercase tracking-wider font-semibold">Total PnL</span>
                </div>
                <div>
                    <span className={`text-3xl font-bold tracking-tight ${stats.totalProfit >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                        {stats.totalProfit > 0 ? "+" : ""}{stats.totalProfit.toFixed(3)}
                    </span>
                    <span className="text-sm text-gray-500 ml-1">SOL</span>
                </div>
            </div>

            {/* Win Rate Card */}
            <div className="glass-panel p-4 flex flex-col justify-between relative overflow-hidden">
                <div className="absolute -right-4 -top-4 bg-[var(--accent)]/10 w-24 h-24 rounded-full blur-2xl"></div>
                <div className="flex items-center gap-2 text-gray-400 mb-1">
                    <Target size={16} />
                    <span className="text-xs uppercase tracking-wider font-semibold">Win Rate</span>
                </div>
                <div className="flex items-end gap-2">
                    <span className="text-3xl font-bold text-white tracking-tight">{winRate}%</span>
                    <div className="text-xs text-gray-500 mb-1">
                        <span className="text-green-500">{stats.wins}W</span> / <span className="text-red-500">{stats.losses}L</span>
                    </div>
                </div>
            </div>

            {/* Daily Target (Mock for UI) */}
            {/* Network Intelligence Card */}
            <div className={`glass-panel p-4 flex flex-col justify-between relative overflow-hidden border ${hasHelius ? 'border-green-500/20' : 'border-yellow-500/20'}`}>
                <div className={`absolute -right-4 -top-4 w-24 h-24 rounded-full blur-2xl ${hasHelius ? 'bg-green-500/10' : 'bg-yellow-500/10'}`}></div>
                <div className="flex items-center gap-2 text-gray-400 mb-1">
                    <TrendingDown size={16} className="rotate-180" />
                    <span className="text-xs uppercase tracking-wider font-semibold">Intelligence Status</span>
                </div>
                <div>
                    <span className={`text-xl font-bold tracking-tight ${hasHelius ? 'text-green-500' : 'text-yellow-500'}`}>
                        {hasHelius ? "ADVANCED (HELIUS)" : "BASIC (PUBLIC)"}
                    </span>
                    <p className="text-[10px] text-gray-500 mt-1">
                        {hasHelius ? "Deep holder & rug analysis active" : "Reduced accuracy - Holders estimated"}
                    </p>
                </div>
            </div>
        </div>
    );
}
