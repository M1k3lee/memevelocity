"use client";

import React from 'react';
import { ArrowUpRight, ArrowDownRight, XCircle, RefreshCw, Search, ExternalLink } from 'lucide-react';
import { ActiveTrade } from '../hooks/usePumpTrader';

interface ActiveTradesProps {
    trades: ActiveTrade[];
    onSell: (mint: string, percent: number) => void;
    onSync?: () => void;
    onRecover?: () => void;
    onClearAll?: () => void;
}

export default function ActiveTrades({ trades, onSell, onSync, onRecover, onClearAll }: ActiveTradesProps) {
    const openTrades = trades.filter(t => t.status === "open" || t.status === "selling");

    if (openTrades.length === 0) {
        return (
            <div className="glass-panel p-6 w-full h-[300px] flex flex-col justify-center items-center text-gray-500 animate-fade-in delay-200">
                <div className="flex flex-col items-center gap-4 w-full mb-4">
                    <div className="flex gap-4">
                        {onSync && (
                            <button onClick={onSync} className="text-xs flex items-center gap-1 text-[var(--primary)] hover:text-white transition-colors">
                                <RefreshCw size={12} /> Sync
                            </button>
                        )}
                        {onRecover && (
                            <button onClick={onRecover} className="text-xs flex items-center gap-1 text-[var(--secondary)] hover:text-white transition-colors">
                                <Search size={12} /> Scan for Lost Tokens
                            </button>
                        )}
                        {onClearAll && (
                            <button onClick={onClearAll} className="text-xs flex items-center gap-1 text-red-500 hover:text-white transition-colors">
                                <XCircle size={12} /> Clear All
                            </button>
                        )}
                    </div>
                </div>
                <p className="text-lg mb-2">No Active Trades</p>
                <p className="text-sm opacity-50">Bot is waiting for opportunities...</p>
            </div>
        );
    }

    return (
        <div className="glass-panel p-6 w-full animate-fade-in delay-200">
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold glow-text">Active Portfolio</h2>
                <div className="flex gap-2">
                    {onRecover && (
                        <button
                            onClick={onRecover}
                            className="p-2 text-gray-400 hover:text-[var(--secondary)] transition-all"
                            title="Scan for untracked tokens"
                        >
                            <Search size={16} />
                        </button>
                    )}
                    {onSync && (
                        <button
                            onClick={onSync}
                            className="p-2 text-gray-400 hover:text-[var(--primary)] transition-all hover:rotate-180 duration-500"
                            title="Sync with Blockchain"
                        >
                            <RefreshCw size={16} />
                        </button>
                    )}
                    {onClearAll && (
                        <button
                            onClick={onClearAll}
                            className="p-2 text-gray-400 hover:text-red-500 transition-all"
                            title="Clear local view"
                        >
                            <XCircle size={16} />
                        </button>
                    )}
                </div>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="text-xs text-gray-400 border-b border-[#222]">
                            <th className="p-2">Token</th>
                            <th className="p-2">Invested</th>
                            <th className="p-2">Entry</th>
                            <th className="p-2">Current</th>
                            <th className="p-2">PnL</th>
                            <th className="p-2 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {openTrades.map((trade) => (
                            <tr key={trade.mint} className="border-b border-[#222]/50 hover:bg-[#1a1a1a]">
                                <td className="p-3 font-bold text-white">
                                    <div className="flex items-center gap-2">
                                        {trade.symbol}
                                        {trade.txId?.startsWith('SIM') && (
                                            <span className="text-[10px] bg-blue-500/20 text-blue-400 border border-blue-500/30 px-1 rounded">SIM</span>
                                        )}
                                        {trade.status === 'selling' && (
                                            <span className="text-[10px] bg-orange-500/20 text-orange-400 border border-orange-500/30 px-1 rounded animate-pulse">SELLING...</span>
                                        )}
                                        {!trade.mint.startsWith('SIM') && (
                                            <a
                                                href={`https://pump.fun/${trade.mint}`}
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
                                    <div className="text-[10px] font-mono text-gray-500">{trade.mint.substring(0, 6)}...</div>
                                </td>
                                <td className="p-3 text-sm text-gray-300">
                                    {trade.amountSolPaid ? `${trade.amountSolPaid.toFixed(3)} SOL` :
                                        (trade.amountTokens * trade.buyPrice > 0 ? `${(trade.amountTokens * trade.buyPrice).toFixed(3)} SOL` : "-")}
                                </td>
                                <td className="p-3 text-sm text-gray-300">
                                    {trade.buyPrice > 0 ? trade.buyPrice.toFixed(9) : "Pending"}
                                </td>
                                <td className="p-3 text-sm text-gray-300">
                                    {(() => {
                                        const isStale = trade.lastPriceUpdate && (Date.now() - trade.lastPriceUpdate > 30000); // 30s stale warning
                                        return (
                                            <div className="flex flex-col">
                                                <span>{trade.currentPrice > 0 ? trade.currentPrice.toFixed(9) : "Updating..."}</span>
                                                {isStale && (
                                                    <span className="text-orange-500 text-[9px] flex items-center gap-1 animate-pulse">
                                                        ⚠️ STALE ({Math.floor((Date.now() - (trade.lastPriceUpdate || 0)) / 1000)}s)
                                                    </span>
                                                )}
                                            </div>
                                        );
                                    })()}
                                </td>
                                <td className="p-3">
                                    {(() => {
                                        // Calculate PnL in real-time as fallback
                                        let displayPnlPercent = trade.pnlPercent;
                                        let displayPnlSol = 0;

                                        if (trade.buyPrice > 0 && trade.currentPrice > 0) {
                                            displayPnlPercent = ((trade.currentPrice - trade.buyPrice) / trade.buyPrice) * 100;
                                            // Calculate SOL PnL: (Current Price - Buy Price) * Amount of Tokens
                                            displayPnlSol = (trade.currentPrice - trade.buyPrice) * trade.amountTokens;
                                        }

                                        if (trade.buyPrice === 0 && trade.currentPrice > 0) {
                                            return <span className="text-gray-500 text-xs">Setting buy price...</span>;
                                        } else if (trade.currentPrice === 0) {
                                            return <span className="text-gray-500 text-xs">Updating price...</span>;
                                        }

                                        return (
                                            <div className="flex flex-col">
                                                <span className={`flex items-center gap-1 font-bold ${displayPnlPercent >= 0 ? "text-green-500" : "text-red-500"}`}>
                                                    {displayPnlPercent >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                                                    {displayPnlPercent.toFixed(2)}%
                                                </span>
                                                <span className={`text-[10px] ${displayPnlSol >= 0 ? "text-green-400/70" : "text-red-400/70"}`}>
                                                    {displayPnlSol >= 0 ? "+" : ""}{displayPnlSol.toFixed(4)} SOL
                                                </span>
                                            </div>
                                        );
                                    })()}
                                </td>
                                <td className="p-3 text-right">
                                    <div className="flex justify-end gap-2">
                                        <button
                                            onClick={() => onSell(trade.mint, 50)}
                                            className="text-xs bg-yellow-500/10 text-yellow-500 border border-yellow-500/20 px-2 py-1 rounded hover:bg-yellow-500/20"
                                        >
                                            Sell 50%
                                        </button>
                                        <button
                                            onClick={() => onSell(trade.mint, 100)}
                                            className="text-xs bg-red-500/10 text-red-500 border border-red-500/20 px-2 py-1 rounded hover:bg-red-500/20 flex items-center gap-1"
                                        >
                                            <XCircle size={12} /> Close
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
