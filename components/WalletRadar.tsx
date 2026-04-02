"use client";

import React from 'react';
import { Radar, Link2, ShieldAlert } from 'lucide-react';

type WalletRadarProps = {
    className?: string;
    radar: {
        summary: {
            trackedLaunches: number;
            recurringWallets: number;
            creatorLedLaunches: number;
            coordinatedLaunches: number;
        };
        wallets: Array<{
            wallet: string;
            tokenCount: number;
            cumulativeVolumeSol: number;
            averageShare: number;
            maxShare: number;
            creatorCount: number;
            dominanceCount: number;
            symbols: string[];
            tags: string[];
        }>;
        linkedTokens: Array<{
            symbol: string;
            wallet: string;
            share: number;
            liquiditySol: number;
            creatorSelling: boolean;
        }>;
    };
};

function formatWallet(wallet: string): string {
    if (!wallet) return 'unknown';
    if (wallet.length <= 10) return wallet;
    return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

export default function WalletRadar({ radar, className = '' }: WalletRadarProps) {
    return (
        <div className={`glass-panel p-5 h-full flex flex-col ${className}`}>
            <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                    <h3 className="font-bold flex items-center gap-2 text-gray-300 text-base">
                        <Radar size={16} /> Wallet Radar
                    </h3>
                    <p className="mt-1 text-xs text-gray-500">Recurring counterparties and linked launch flow across the current tape.</p>
                </div>
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] uppercase tracking-[0.24em] text-gray-500">
                    {radar.summary.trackedLaunches} launches
                </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-cyan-500/15 bg-cyan-500/8 px-4 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-cyan-300/70">Recurring Wallets</div>
                    <div className="mt-1 text-2xl font-semibold text-cyan-300">{radar.summary.recurringWallets}</div>
                </div>
                <div className="rounded-xl border border-red-500/15 bg-red-500/8 px-4 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-red-300/70">Creator-led Tapes</div>
                    <div className="mt-1 text-2xl font-semibold text-red-300">{radar.summary.creatorLedLaunches}</div>
                </div>
                <div className="rounded-xl border border-amber-500/15 bg-amber-500/8 px-4 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-amber-300/70">Coordinated Tapes</div>
                    <div className="mt-1 text-2xl font-semibold text-amber-300">{radar.summary.coordinatedLaunches}</div>
                </div>
                <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/8 px-4 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-emerald-300/70">Linked Launches</div>
                    <div className="mt-1 text-2xl font-semibold text-emerald-300">{radar.linkedTokens.length}</div>
                </div>
            </div>

            <div className="mt-5 flex-1 overflow-y-auto pr-1 space-y-4 custom-scrollbar">
                <div>
                    <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-gray-500">Recurring Wallets</div>
                    <div className="space-y-2">
                        {radar.wallets.length > 0 ? radar.wallets.map((wallet) => (
                            <div key={wallet.wallet} className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="font-mono text-xs text-gray-200">{formatWallet(wallet.wallet)}</div>
                                        <div className="mt-1 text-[10px] uppercase tracking-wide text-gray-500">
                                            {wallet.tokenCount} tapes · {wallet.cumulativeVolumeSol.toFixed(2)} SOL tracked
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-xs font-semibold text-white">{(wallet.maxShare * 100).toFixed(0)}%</div>
                                        <div className="text-[10px] text-gray-500">max share</div>
                                    </div>
                                </div>

                                <div className="mt-3 flex flex-wrap gap-2">
                                    {wallet.tags.map((tag) => (
                                        <span key={`${wallet.wallet}-${tag}`} className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] uppercase tracking-wide text-gray-400">
                                            {tag}
                                        </span>
                                    ))}
                                </div>

                                <div className="mt-3 flex flex-wrap gap-2">
                                    {wallet.symbols.map((symbol) => (
                                        <span key={`${wallet.wallet}-${symbol}`} className="rounded-full border border-cyan-500/10 bg-cyan-500/8 px-2 py-1 text-[10px] font-mono text-cyan-200">
                                            {symbol}
                                        </span>
                                    ))}
                                </div>

                                <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] text-gray-500">
                                    <div>
                                        <div className="uppercase tracking-wide">Avg Share</div>
                                        <div className="mt-1 text-xs text-gray-300">{(wallet.averageShare * 100).toFixed(0)}%</div>
                                    </div>
                                    <div>
                                        <div className="uppercase tracking-wide">Creator Hits</div>
                                        <div className="mt-1 text-xs text-gray-300">{wallet.creatorCount}</div>
                                    </div>
                                    <div>
                                        <div className="uppercase tracking-wide">Dominance</div>
                                        <div className="mt-1 text-xs text-gray-300">{wallet.dominanceCount}</div>
                                    </div>
                                </div>
                            </div>
                        )) : (
                            <div className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-4 text-xs text-gray-500">
                                Waiting for repeated-wallet flow to form.
                            </div>
                        )}
                    </div>
                </div>

                <div>
                    <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-gray-500">
                        <Link2 size={12} /> Linked Launches
                    </div>
                    <div className="space-y-2">
                        {radar.linkedTokens.length > 0 ? radar.linkedTokens.map((entry, index) => (
                            <div key={`${entry.wallet}-${entry.symbol}-${index}`} className="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 text-xs">
                                <div>
                                    <div className="font-semibold text-gray-200">{entry.symbol}</div>
                                    <div className="mt-1 font-mono text-[10px] text-gray-500">{formatWallet(entry.wallet)}</div>
                                </div>
                                <div className="text-right">
                                    <div className="text-gray-200">{(entry.share * 100).toFixed(0)}% share</div>
                                    <div className="mt-1 text-[10px] text-gray-500">{entry.liquiditySol.toFixed(1)} SOL</div>
                                </div>
                                {entry.creatorSelling ? (
                                    <ShieldAlert size={14} className="shrink-0 text-red-400" />
                                ) : null}
                            </div>
                        )) : (
                            <div className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-4 text-xs text-gray-500">
                                No linked launch clusters yet.
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
