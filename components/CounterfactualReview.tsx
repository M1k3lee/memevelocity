"use client";

import React from 'react';
import { FlaskConical, ArrowUpRight, ArrowDownRight, ShieldCheck, Clock3 } from 'lucide-react';

type CounterfactualReviewProps = {
    review: {
        summary: {
            saved: number;
            missed: number;
            mixed: number;
            pending: number;
        };
        items: Array<{
            token: string;
            mode: string;
            action: string;
            verdict: 'saved' | 'missed' | 'mixed' | 'pending';
            headline: string;
            reasonLabel: string;
            peakMove: number;
            currentMove: number;
            creatorSells: number;
            liquiditySol: number;
        }>;
    };
};

function verdictStyles(verdict: CounterfactualReviewProps['review']['items'][number]['verdict']): string {
    if (verdict === 'saved') return 'border-emerald-500/20 bg-emerald-500/8 text-emerald-300';
    if (verdict === 'missed') return 'border-amber-500/20 bg-amber-500/8 text-amber-300';
    if (verdict === 'mixed') return 'border-sky-500/20 bg-sky-500/8 text-sky-300';
    return 'border-white/10 bg-white/[0.04] text-gray-400';
}

export default function CounterfactualReview({ review }: CounterfactualReviewProps) {
    return (
        <div className="glass-panel p-5">
            <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                    <h3 className="font-bold flex items-center gap-2 text-gray-300 text-base">
                        <FlaskConical size={16} /> Counterfactual Review
                    </h3>
                    <p className="mt-1 text-xs text-gray-500">Live grade of recent waits and rejects against what the tape did afterward.</p>
                </div>
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] uppercase tracking-[0.24em] text-gray-500">
                    {review.items.length} checks
                </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/8 px-4 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-emerald-300/70">Saved</div>
                    <div className="mt-1 text-2xl font-semibold text-emerald-300">{review.summary.saved}</div>
                </div>
                <div className="rounded-xl border border-amber-500/15 bg-amber-500/8 px-4 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-amber-300/70">Missed</div>
                    <div className="mt-1 text-2xl font-semibold text-amber-300">{review.summary.missed}</div>
                </div>
                <div className="rounded-xl border border-sky-500/15 bg-sky-500/8 px-4 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-sky-300/70">Mixed</div>
                    <div className="mt-1 text-2xl font-semibold text-sky-300">{review.summary.mixed}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-gray-500">Pending</div>
                    <div className="mt-1 text-2xl font-semibold text-gray-200">{review.summary.pending}</div>
                </div>
            </div>

            <div className="mt-5 space-y-2.5">
                {review.items.length > 0 ? review.items.map((item, index) => (
                    <div key={`${item.token}-${item.action}-${index}`} className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <div className="flex items-center gap-2">
                                    <span className="font-semibold text-gray-200">{item.token}</span>
                                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] uppercase tracking-wide text-gray-500">
                                        {item.mode}
                                    </span>
                                    <span className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-wide ${verdictStyles(item.verdict)}`}>
                                        {item.verdict}
                                    </span>
                                </div>
                                <div className="mt-2 text-sm text-gray-200">{item.headline}</div>
                                <div className="mt-1 text-xs text-gray-500">{item.reasonLabel}</div>
                            </div>
                            <div className="text-right text-xs">
                                <div className="flex items-center justify-end gap-1 text-gray-300">
                                    {item.peakMove >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                                    peak {item.peakMove >= 0 ? '+' : ''}{item.peakMove.toFixed(1)}%
                                </div>
                                <div className="mt-1 text-[10px] text-gray-500">
                                    now {item.currentMove >= 0 ? '+' : ''}{item.currentMove.toFixed(1)}%
                                </div>
                            </div>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2 text-[10px]">
                            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-gray-400">
                                {item.action}
                            </span>
                            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-gray-400">
                                {item.liquiditySol.toFixed(1)} SOL liquidity
                            </span>
                            {item.creatorSells > 0 ? (
                                <span className="rounded-full border border-red-500/20 bg-red-500/10 px-2 py-1 text-red-300">
                                    {item.creatorSells} creator sells
                                </span>
                            ) : (
                                <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-emerald-300">
                                    <ShieldCheck size={10} className="mr-1 inline-block" />
                                    creator stayed clean
                                </span>
                            )}
                        </div>
                    </div>
                )) : (
                    <div className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-4 text-xs text-gray-500">
                        <Clock3 size={14} className="mr-2 inline-block" />
                        Waiting for enough logged skips to review.
                    </div>
                )}
            </div>
        </div>
    );
}
