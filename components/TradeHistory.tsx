"use client";

import React from 'react';
import { History, ArrowUpRight, ArrowDownRight, ExternalLink } from 'lucide-react';
import { ActiveTrade } from '../hooks/usePumpTrader';

interface TradeHistoryProps {
    trades: ActiveTrade[];
}

export default function TradeHistory({ trades }: TradeHistoryProps) {
    // Filter for closed trades only
    const history = trades.filter(t => t.status === "closed");

    return (
        <div className="glass-panel p-6 w-full flex flex-col h-[400px] animate-fade-in delay-300">
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-bold glow-text flex items-center gap-2">
                    <History size={18} /> Trade History
                </h2>
                <span className="text-xs text-gray-500">{history.length} trades executed</span>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar">
                {history.length === 0 ? (
                    <div className="h-full flex flex-col justify-center items-center text-gray-600">
                        <p>No trade history yet.</p>
                    </div>
                ) : (
                    <table className="w-full text-left border-collapse text-xs">
                        <thead className="sticky top-0 bg-[#0a0a0a] z-10">
                            <tr className="text-gray-500 border-b border-[#222]">
                                <th className="p-2">Token</th>
                                <th className="p-2">Price In</th>
                                <th className="p-2">Price Out</th>
                                <th className="p-2 text-right">PnL</th>
                            </tr>
                        </thead>
                        <tbody>
                            {history.map((trade, i) => (
                                <tr key={`${trade.mint}-${i}`} className="border-b border-[#222]/30 hover:bg-[#151515] transition-colors">
                                    <td className="p-2">
                                        <div className="flex items-center gap-2">
                                            <span className="font-bold text-gray-300">{trade.symbol}</span>
                                            {trade.txId?.startsWith("SIM") && <span className="text-[9px] text-blue-500 bg-blue-500/10 px-1 rounded">SIM</span>}
                                            {!trade.mint.startsWith('SIM') && (
                                                <a
                                                    href={`https://pump.fun/${trade.mint}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    onClick={(e) => e.stopPropagation()}
                                                    className="text-[var(--primary)] hover:text-white transition-colors"
                                                    title="View on pump.fun"
                                                >
                                                    <ExternalLink size={10} />
                                                </a>
                                            )}
                                        </div>
                                    </td>
                                    <td className="p-2 font-mono text-gray-500">{trade.buyPrice.toFixed(9)}</td>
                                    <td className="p-2 font-mono text-gray-500">{trade.currentPrice.toFixed(9)}</td>
                                    <td className="p-2 text-right font-bold">
                                        <span className={`flex items-center justify-end gap-1 ${trade.pnlPercent >= 0 ? "text-green-500" : "text-red-500"}`}>
                                            {trade.pnlPercent >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
                                            {trade.pnlPercent.toFixed(2)}%
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
