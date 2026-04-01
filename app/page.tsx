"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { createConnection, getPumpData } from '../utils/solanaManager';
import { usePumpTrader } from '../hooks/usePumpTrader';
import type { TokenData } from '../types/token';
import { AlertOctagon, Terminal, LayoutDashboard, Wallet, Settings, Activity } from 'lucide-react';
import { quickFirstBuyerCheck, analyzeFirstBuyer } from '../utils/firstBuyer';
import { quickSpeedCheck, analyzeSpeedTrade } from '../utils/speedTrader';
import { analyzeEnhanced, type EnhancedAnalysis } from '../utils/enhancedAnalyzer';
import { getMarketSnapshot } from '../utils/marketData';
import { getLatestToken } from '../utils/liveTokenStore';
import { fitTradeAmountToBalance } from '../utils/tradeSizing';
import { getTokenIdentityKey, hasUsableTokenIdentity } from '../utils/tokenIdentity';
import { getIdentityQuarantine } from '../utils/rugDetector';
import { formatTokenPrice } from '../utils/priceFormat';
import { calculateBondingCurveProgress, calculatePumpPrice } from '../utils/pumpMath';
import { getTokenAgeSeconds } from '../utils/tokenTiming';
import { evaluateLiveEntryGuard } from '../utils/liveEntryGuard';
import {
  getProfitLockFloor,
  getRunnerActivationProfit,
  getRunnerMaxHoldTime,
  getRunnerTimeExitFloor,
  getRunnerTrailingStopPercent,
  getTp1SellPercent,
  getTp2SellPercent,
  hasTp1Sell,
  hasTp2Sell
} from '../utils/tradeExit';

// Dynamic imports for components
const WalletManager = dynamic(() => import('../components/WalletManager'), { ssr: false });
const BotControls = dynamic(() => import('../components/BotControls'), { ssr: false });
const LiveFeed = dynamic(() => import('../components/LiveFeed'), { ssr: false });
const ActiveTrades = dynamic(() => import('../components/ActiveTrades'), { ssr: false });
const DashboardStats = dynamic(() => import('../components/DashboardStats'), { ssr: false });
const TradeHistory = dynamic(() => import('../components/TradeHistory'), { ssr: false });

const PAPER_TRADE_EXIT_WARMUP_SECONDS = 10;
const LIVE_TRADE_SETTLEMENT_WARMUP_SECONDS = 20;
const MIN_VIABLE_LIVE_TRADE_SOL = 0.0025;
const MICRO_WALLET_MAX_SOL = 0.05;
const BOT_CONFIG_STORAGE_KEY = 'pump_bot_config';

type DecisionSignalKind = 'wait' | 'reject' | 'approve' | 'buy' | 'retry' | 'info';

type ParsedDecisionSignal = {
  timeLabel: string;
  mode: string;
  kind: DecisionSignalKind;
  token: string;
  reason: string;
  raw: string;
};

type DecisionPulse = {
  counts: Record<DecisionSignalKind, number>;
  modeStats: Array<{
    mode: string;
    total: number;
    waits: number;
    rejects: number;
    approvals: number;
    buys: number;
  }>;
  topReasons: Array<{ label: string; count: number }>;
  recentSignals: ParsedDecisionSignal[];
  totalSignals: number;
};

function isMicroWalletBalance(balance: number | null | undefined): boolean {
  return typeof balance === 'number' && Number.isFinite(balance) && balance > 0 && balance <= MICRO_WALLET_MAX_SOL;
}

function getLiveExitWarmupSeconds(mode: string | undefined): number {
  if (mode === 'micro') return 6;
  if (mode === 'god') return 12;
  if (mode === 'degen') return 6;
  return LIVE_TRADE_SETTLEMENT_WARMUP_SECONDS;
}

function getPaperExitWarmupSeconds(trade: { exitStrategy?: { maxHoldTime?: number } }): number {
  const maxHoldTime = trade.exitStrategy?.maxHoldTime;
  if (maxHoldTime && maxHoldTime <= 30) return 2;
  if (maxHoldTime && maxHoldTime <= 45) return 3;
  if (maxHoldTime && maxHoldTime <= 90) return 4;
  if (maxHoldTime && maxHoldTime <= 120) return 6;
  return PAPER_TRADE_EXIT_WARMUP_SECONDS;
}

function normalizeDecisionMode(rawMode: string | undefined): string {
  const mode = (rawMode || '').trim().toUpperCase();
  if (!mode) return 'GENERAL';
  if (mode === 'DEGEN' || mode === 'HIGH' || mode === 'VELOCITY' || mode === 'SCALP') return 'AGGRESSIVE';
  if (mode === 'FIRST' || mode === 'SNIPER' || mode === 'PROBE') return 'EXPERIMENTAL';
  return mode;
}

function classifyDecisionReason(reason: string): string {
  const normalized = reason.toLowerCase();
  if (normalized.includes('opening chaos')) return 'Opening chaos';
  if (normalized.includes('creator already sold')) return 'Creator sold';
  if (normalized.includes('already too extended')) return 'Too extended';
  if (normalized.includes('top 2 wallets') || normalized.includes('concentrated') || normalized.includes('dominant')) return 'Wallet concentration';
  if (normalized.includes('one-sided')) return 'One-sided flow';
  if (normalized.includes('shakeout')) return 'Needs shakeout';
  if (normalized.includes('composite score') || normalized.includes('runner floor')) return 'Score too low';
  if (normalized.includes('failed the runner gate')) return 'Runner gate failed';
  if (normalized.includes('verification')) return 'Verification issue';
  if (normalized.includes('rug')) return 'Rug risk';
  if (normalized.includes('too new') || normalized.includes('still early')) return 'Too early';
  if (normalized.includes('buy pressure')) return 'Weak buy pressure';
  return reason.length > 48 ? `${reason.slice(0, 48)}…` : reason;
}

function parseDecisionSignal(log: string): ParsedDecisionSignal | null {
  const timeMatch = log.match(/^\[([^\]]+)\]\s*/);
  const timeLabel = timeMatch?.[1] || '';
  const message = log.replace(/^\[[^\]]+\]\s*/, '').trim();

  let match = message.match(/^([A-Z]+)\s+(wait|Reject):\s+(\S+)\s*(.*)$/i);
  if (match) {
    const mode = normalizeDecisionMode(match[1]);
    const kind = match[2].toLowerCase() === 'wait' ? 'wait' : 'reject';
    const token = match[3];
    const reason = match[4].trim();
    return { timeLabel, mode, kind, token, reason, raw: message };
  }

  match = message.match(/^([A-Z]+)\s+setup:\s+(\S+)\s+-\s+(.*)$/i);
  if (match) {
    return {
      timeLabel,
      mode: normalizeDecisionMode(match[1]),
      kind: 'approve',
      token: match[2],
      reason: match[3].trim(),
      raw: message
    };
  }

  match = message.match(/^🧪\s+EARLY PROBE:\s+(\S+)\s+-\s+(.*)$/i);
  if (match) {
    return { timeLabel, mode: 'EXPERIMENTAL', kind: 'buy', token: match[1], reason: match[2].trim(), raw: message };
  }

  match = message.match(/^🔥\s+AGGRESSIVE BUY:\s+(\S+)\s+-\s+(.*)$/i);
  if (match) {
    return { timeLabel, mode: 'AGGRESSIVE', kind: 'buy', token: match[1], reason: match[2].trim(), raw: message };
  }

  match = message.match(/^✅\s+APPROVED:\s+(\S+)\s+-\s+(.*)$/i);
  if (match) {
    return { timeLabel, mode: 'GENERAL', kind: 'approve', token: match[1], reason: match[2].trim(), raw: message };
  }

  match = message.match(/^🔄\s+Re-analyzing\s+(\S+)\s+\(Wait period over\)\.\.\.$/i);
  if (match) {
    return { timeLabel, mode: 'GENERAL', kind: 'retry', token: match[1], reason: 'Retry window elapsed', raw: message };
  }

  match = message.match(/^🚫\s+(?:Guard\s+)?Reject(?:ed)?:\s+(\S+)\s+-\s+(.*)$/i);
  if (match) {
    return { timeLabel, mode: 'GENERAL', kind: 'reject', token: match[1], reason: match[2].trim(), raw: message };
  }

  match = message.match(/^⏳\s+(\S+)\s+(.*)$/i);
  if (match) {
    return { timeLabel, mode: 'GENERAL', kind: 'wait', token: match[1], reason: match[2].trim(), raw: message };
  }

  return null;
}

function buildDecisionPulse(logs: string[]): DecisionPulse {
  const counts: Record<DecisionSignalKind, number> = {
    wait: 0,
    reject: 0,
    approve: 0,
    buy: 0,
    retry: 0,
    info: 0
  };
  const modeStats = new Map<string, { mode: string; total: number; waits: number; rejects: number; approvals: number; buys: number }>();
  const reasonCounts = new Map<string, number>();
  const recentSignals: ParsedDecisionSignal[] = [];

  for (const log of logs) {
    const parsed = parseDecisionSignal(log);
    if (!parsed) continue;

    counts[parsed.kind] += 1;
    if (recentSignals.length < 8) {
      recentSignals.push(parsed);
    }

    const current = modeStats.get(parsed.mode) || {
      mode: parsed.mode,
      total: 0,
      waits: 0,
      rejects: 0,
      approvals: 0,
      buys: 0
    };
    current.total += 1;
    if (parsed.kind === 'wait') current.waits += 1;
    if (parsed.kind === 'reject') current.rejects += 1;
    if (parsed.kind === 'approve') current.approvals += 1;
    if (parsed.kind === 'buy') current.buys += 1;
    modeStats.set(parsed.mode, current);

    if (parsed.kind === 'wait' || parsed.kind === 'reject') {
      const reasonLabel = classifyDecisionReason(parsed.reason);
      reasonCounts.set(reasonLabel, (reasonCounts.get(reasonLabel) || 0) + 1);
    }
  }

  return {
    counts,
    modeStats: [...modeStats.values()].sort((a, b) => b.total - a.total).slice(0, 4),
    topReasons: [...reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, count]) => ({ label, count })),
    recentSignals,
    totalSignals: counts.wait + counts.reject + counts.approve + counts.buy + counts.retry
  };
}

function getBondingCurveProgressFromFeed(token: TokenData): number {
  return calculateBondingCurveProgress(token.vTokensInBondingCurve);
}

function calculateTraderDiversity(uniqueTraderCount: number, tradeCount: number): number {
  if (!Number.isFinite(uniqueTraderCount) || !Number.isFinite(tradeCount) || uniqueTraderCount <= 0 || tradeCount <= 0) {
    return 0;
  }

  return Math.min(1, uniqueTraderCount / Math.max(1, tradeCount));
}

function calculateMicroVelocityScore(params: {
  age: number;
  observedVolume: number;
  tradeCount: number;
  uniqueTraderCount: number;
  buyPressure: number;
  netFlow: number;
  bondingCurveProgress: number;
  sellCount: number;
  priceChangePercent: number;
}): number {
  const {
    age,
    observedVolume,
    tradeCount,
    uniqueTraderCount,
    buyPressure,
    netFlow,
    bondingCurveProgress,
    sellCount,
    priceChangePercent
  } = params;

  const capitalEfficiency = observedVolume / Math.max(1, tradeCount);
  const traderDiversity = calculateTraderDiversity(uniqueTraderCount, tradeCount);
  const curveVelocity = age > 0 ? (bondingCurveProgress / age) * 60 : 0;
  const netFlowVelocity = age > 0 ? (netFlow / age) * 60 : 0;

  let score = 35;

  if (capitalEfficiency >= 0.12) score += 22;
  else if (capitalEfficiency >= 0.08) score += 14;
  else if (capitalEfficiency >= 0.05) score += 6;
  else score -= 20;

  if (curveVelocity >= 1.2) score += 18;
  else if (curveVelocity >= 0.8) score += 10;
  else if (curveVelocity < 0.35) score -= 12;

  if (netFlowVelocity >= 0.75) score += 14;
  else if (netFlowVelocity >= 0.4) score += 8;
  else if (netFlowVelocity < 0.18) score -= 10;

  if (buyPressure >= 0.65) score += 10;
  else if (buyPressure >= 0.55) score += 5;
  else if (buyPressure < 0.48) score -= 10;

  if (traderDiversity >= 0.5) score += 10;
  else if (traderDiversity >= 0.4) score += 5;
  else if (traderDiversity < 0.3) score -= 12;

  if (sellCount <= Math.max(1, tradeCount * 0.25)) score += 6;
  else if (sellCount > Math.max(2, tradeCount * 0.45)) score -= 8;

  if (priceChangePercent >= 1.5) score += 6;
  else if (priceChangePercent <= -1.5) score -= 8;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function estimateCurveBuyImpactPercent(liquiditySol: number, amountSol: number): number {
  if (!Number.isFinite(liquiditySol) || liquiditySol <= 0 || !Number.isFinite(amountSol) || amountSol <= 0) {
    return 100;
  }

  return (amountSol / liquiditySol) * 100;
}

function calculateGodModeScore(params: {
  age: number;
  observedVolume: number;
  tradeCount: number;
  uniqueTraderCount: number;
  buyPressure: number;
  bondingCurveProgress: number;
  netFlow: number;
  priceChangePercent: number;
  stressImpactPercent: number;
  top10Concentration: number;
  creatorHoldings: number;
  largestTraderVolumeShare: number;
  topTwoTraderVolumeShare: number;
  creatorSellCount: number;
}): number {
  const {
    age,
    observedVolume,
    tradeCount,
    uniqueTraderCount,
    buyPressure,
    bondingCurveProgress,
    netFlow,
    priceChangePercent,
    stressImpactPercent,
    top10Concentration,
    creatorHoldings,
    largestTraderVolumeShare,
    topTwoTraderVolumeShare,
    creatorSellCount
  } = params;

  const capitalEfficiency = observedVolume / Math.max(1, tradeCount);
  const traderDiversity = calculateTraderDiversity(uniqueTraderCount, tradeCount);
  const curveVelocity = age > 0 ? (bondingCurveProgress / age) * 60 : 0;
  const flowVelocity = age > 0 ? (netFlow / age) * 60 : 0;
  let score = 28;

  if (age >= 8 && age <= 90) score += 10;
  else if (age > 120) score -= 10;

  if (observedVolume >= 1.5) score += 16;
  else if (observedVolume >= 1.0) score += 10;
  else score -= 14;

  if (capitalEfficiency >= 0.12) score += 14;
  else if (capitalEfficiency >= 0.09) score += 8;
  else score -= 12;

  if (buyPressure >= 0.66) score += 12;
  else if (buyPressure >= 0.58) score += 7;
  else score -= 12;

  if (uniqueTraderCount >= 8) score += 10;
  else if (uniqueTraderCount >= 6) score += 5;
  else score -= 10;

  if (traderDiversity >= 0.5) score += 10;
  else if (traderDiversity >= 0.42) score += 5;
  else score -= 8;

  if (curveVelocity >= 0.9) score += 10;
  else if (curveVelocity >= 0.65) score += 6;
  else score -= 10;

  if (flowVelocity >= 0.45) score += 8;
  else if (flowVelocity < 0.2) score -= 8;

  if (priceChangePercent >= 1 && priceChangePercent <= 10) score += 6;
  else if (priceChangePercent > 14 || priceChangePercent < -2) score -= 10;

  if (stressImpactPercent <= 1.8) score += 8;
  else if (stressImpactPercent <= 2.4) score += 4;
  else score -= 14;

  if (top10Concentration > 0) {
    if (top10Concentration <= 22) score += 10;
    else if (top10Concentration > 28) score -= 12;
  }

  if (creatorHoldings >= 0) {
    if (creatorHoldings <= 4) score += 8;
    else if (creatorHoldings > 8) score -= 12;
  }

  if (largestTraderVolumeShare > 0) {
    if (largestTraderVolumeShare <= 0.22) score += 10;
    else if (largestTraderVolumeShare <= 0.3) score += 4;
    else score -= 14;
  }

  if (topTwoTraderVolumeShare > 0) {
    if (topTwoTraderVolumeShare <= 0.4) score += 8;
    else if (topTwoTraderVolumeShare > 0.52) score -= 10;
  }

  if (creatorSellCount > 0) {
    score -= 35;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildPaperTradeFallbackAnalysis(token: TokenData, age: number, momentum: number): EnhancedAnalysis {
  const snapshot = getMarketSnapshot(token.mint);
  const liquidity = token.vSolInBondingCurve || 30;
  const liquidityGrowth = liquidity - 30;
  const bondingCurveProgress = getBondingCurveProgressFromFeed(token);
  const observedVolume = snapshot?.observedVolumeSol || Math.max(0, liquidityGrowth);
  const tradeCount = snapshot?.tradeCount || 0;
  const uniqueTraderCount = snapshot?.uniqueTraderCount || 0;
  const buyPressure = snapshot?.buyPressure ?? 0.5;
  const priceChangePercent = snapshot?.priceChangePercent || 0;
  const largestTraderVolumeShare = snapshot?.largestTraderVolumeShare || 0;
  const topTwoTraderVolumeShare = snapshot?.topTwoTraderVolumeShare || 0;
  const creatorVolumeShare = snapshot?.creatorVolumeShare || 0;
  const creatorBuyCount = snapshot?.creatorBuyCount || 0;
  const creatorSellCount = snapshot?.creatorSellCount || 0;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const strengths: string[] = [];

  let score = 18;

  if (hasUsableTokenIdentity(token.symbol) || hasUsableTokenIdentity(token.name)) {
    score += 12;
    strengths.push('Launch feed metadata present');
  } else {
    warnings.push('Using mint fallback identity');
  }

  if (liquidity >= 35) {
    score += 22;
    strengths.push(`High liquidity: ${liquidity.toFixed(1)} SOL`);
  } else if (liquidity >= 32) {
    score += 14;
  } else if (liquidity < 31) {
    score -= 18;
    reasons.push('Liquidity too low for paper trade');
  }

  if (liquidityGrowth >= 2) {
    score += 18;
    strengths.push(`Liquidity growth: +${liquidityGrowth.toFixed(1)} SOL`);
  } else if (liquidityGrowth > 0.5) {
    score += 10;
  } else if (liquidityGrowth < 0) {
    score -= 15;
    warnings.push('Liquidity is fading');
  } else {
    warnings.push('Liquidity growth is still shallow');
  }

  if (momentum >= 1.5) {
    score += 18;
    strengths.push(`Strong momentum: ${momentum.toFixed(1)} SOL/min`);
  } else if (momentum >= 0.5) {
    score += 10;
  } else {
    score -= 8;
    warnings.push('Momentum is weak');
  }

  if (buyPressure >= 0.65) {
    score += 10;
  } else if (tradeCount > 0 && buyPressure < 0.4) {
    score -= 10;
    warnings.push('Sell pressure is elevated');
  }

  if (tradeCount >= 4) score += 8;
  if (uniqueTraderCount >= 4) score += 6;

  if (priceChangePercent <= -10) {
    score -= 15;
    reasons.push('Price is falling too quickly');
  } else if (priceChangePercent >= 5) {
    score += 6;
  }

  if (age > 180) {
    score -= 10;
    warnings.push('Token is getting stale');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const passed = score >= 35 && liquidity >= 31 && liquidityGrowth >= 0 && momentum >= 0.25;
  const riskLevel: EnhancedAnalysis['riskLevel'] =
    score >= 60 ? 'medium' :
      score >= 35 ? 'high' :
        'critical';

  return {
    score,
    riskLevel,
    passed,
    reasons,
    warnings,
    strengths,
    bondingCurveProgress,
    marketCap: liquidity,
    tiers: {
      tier0: 0,
      tier1: 0,
      tier2: 0,
      tier3: 0,
      tier4: 0,
      totalScore: score * 5
    },
    metrics: {
      holderCount: uniqueTraderCount,
      deployerHoldings: -1,
      top10Concentration: 0,
      observedVolume,
      buyPressure,
      bondingCurveVelocity: age > 0 ? (bondingCurveProgress / age) * 60 : 0,
      liquidityDepth: liquidity,
      tradeCount,
      uniqueTraderCount,
      priceChangePercent,
      largestTraderVolumeShare,
      topTwoTraderVolumeShare,
      creatorVolumeShare,
      creatorBuyCount,
      creatorSellCount,
      contractSecurity: {
        freezeAuthority: false,
        mintAuthority: false,
        updateAuthority: false
      }
    }
  };
}

function evaluateLiveSniperConfirmation(token: TokenData, age: number): { decision: 'pass' | 'wait' | 'reject'; reason?: string; waitTimeMs?: number } {
  const liquidity = token.vSolInBondingCurve || 30;
  const liquidityGrowth = liquidity - 30;
  const momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0;
  const fallbackAnalysis = buildPaperTradeFallbackAnalysis(token, age, momentum);
  const guardDecision = evaluateLiveEntryGuard('sniper', token, fallbackAnalysis, 0.002);

  if (guardDecision.status === 'pass') {
    return { decision: 'pass' };
  }

  if (guardDecision.status === 'wait') {
    return {
      decision: 'wait',
      reason: guardDecision.reason || 'Waiting for early probe confirmation',
      waitTimeMs: age < 15 ? 6000 : 8000
    };
  }

  return {
    decision: 'reject',
    reason: guardDecision.reason || 'Early probe rejected'
  };
}

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [wallet, setWallet] = useState<any>(null);
  // Initialize config with Helius key from localStorage if available (client-side only)
  const [config, setConfig] = useState<any>(() => {
    const savedKey = typeof window !== 'undefined' ? localStorage.getItem('helius_api_key') : '';
    const defaultConfig = {
      isRunning: false,
      mode: 'god',
      amount: 0.008,
      takeProfit: 30,
      stopLoss: 5,
      isDemo: false,
      isSimulating: false,
      heliusKey: savedKey || '',
      maxConcurrentTrades: 1,
      dynamicSizing: true
    };

    if (typeof window === 'undefined') {
      return defaultConfig;
    }

    try {
      const savedConfigRaw = localStorage.getItem(BOT_CONFIG_STORAGE_KEY);
      if (!savedConfigRaw) {
        return defaultConfig;
      }

      const savedConfig = JSON.parse(savedConfigRaw);
      return {
        ...defaultConfig,
        ...savedConfig,
        isRunning: false,
        heliusKey: savedKey || ''
      };
    } catch {
      return defaultConfig;
    }
  });
  const [activeTab, setActiveTab] = useState<'dashboard' | 'wallet' | 'settings'>('dashboard');
  const [realBalance, setRealBalance] = useState(-1); // -1 = Loading/Waiting for RPC
  const balanceRef = useRef(-1);
  const flickerCount = useRef(0);

  useEffect(() => {
    setMounted(true);
    // Load Helius key from localStorage and sync with config
    const loadHeliusKey = () => {
      const savedHelius = localStorage.getItem('helius_api_key');
      if (savedHelius) {
        setConfig((prev: any) => ({ ...prev, heliusKey: savedHelius }));
      } else {
        setConfig((prev: any) => ({ ...prev, heliusKey: '' }));
      }
    };

    loadHeliusKey();

    // Listen for custom event when key is updated in WalletManager (same tab)
    const handleHeliusKeyUpdate = () => {
      loadHeliusKey();
    };

    // Listen for storage changes (when key is updated in another tab)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'helius_api_key') {
        const newKey = e.newValue || '';
        setConfig((prev: any) => ({ ...prev, heliusKey: newKey }));
      }
    };

    window.addEventListener('heliusKeyUpdated', handleHeliusKeyUpdate);
    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener('heliusKeyUpdated', handleHeliusKeyUpdate);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  // Use Helius for RPC if key is present to bypass public node limits/blocks
  // Initialize connection with Helius key from config (which is loaded from localStorage)
  const [connection, setConnection] = useState(() => {
    if (typeof window !== 'undefined') {
      const savedHelius = localStorage.getItem('helius_api_key') || '';
      console.log(`[page.tsx] Initial connection - Helius key from localStorage: ${savedHelius ? savedHelius.substring(0, 8) + '...' : 'not found'}`);
      return createConnection(savedHelius);
    }
    return createConnection();
  });

  useEffect(() => {
    // Only update if key actually changed to avoid unnecessary resets
    if (config.heliusKey) {
      console.log(`[page.tsx] Updating connection with Helius key: ${config.heliusKey.substring(0, 8)}...`);
      setConnection(createConnection(config.heliusKey));
    } else if (mounted) {
      // Only revert to public if we are mounted and explicitly have no key
      console.log(`[page.tsx] No Helius key, using public RPC`);
      setConnection(createConnection());
    }
  }, [config.heliusKey, mounted]);

  useEffect(() => {
    if (!mounted) return;

    const { heliusKey: _heliusKey, isRunning: _isRunning, ...persistedConfig } = config;
    localStorage.setItem(BOT_CONFIG_STORAGE_KEY, JSON.stringify(persistedConfig));
  }, [config, mounted]);

  const {
    activeTrades,
    tradeHistory,
    buyToken,
    sellToken,
    syncTrades,
    recoverTrades,
    clearTrades,
    updateTrade,
    logs,
    addLog,
    clearLogs,
    setDemoMode,
    demoBalance,
    stats,
    isCleaning,
    cleanupWaste,
    vaultBalance,
    profitProtectionEnabled,
    profitProtectionPercent,
    withdrawFromVault,
    moveVaultToTrading,
    toggleProfitProtection,
    setProfitProtectionPercentage,
    clearVault
  } = usePumpTrader(wallet?.keypair, connection, config.heliusKey);
  const displayPaperMode = !!config.isDemo;
  const displayedActiveTrades = activeTrades.filter((trade) => displayPaperMode ? !!trade.isPaper : !trade.isPaper);
  const displayedTradeHistory = tradeHistory.filter((trade) => trade.status === "closed" && (displayPaperMode ? !!trade.isPaper : !trade.isPaper));
  const displayedStats = displayedTradeHistory.reduce((acc: { totalProfit: number; walletDelta: number; rentRecovered: number; wins: number; losses: number; }, trade) => {
    const originalCost = trade.originalAmount || trade.amountSolPaid || 0;
    const realizedProfit = trade.realizedPnlSol ?? ((trade.pnlPercent / 100) * originalCost);
    const realizedWalletDelta = trade.realizedWalletDeltaSol ?? realizedProfit;
    const rentRecovered = trade.rentRecoveredSol || 0;
    acc.totalProfit += realizedProfit;
    acc.walletDelta += realizedWalletDelta;
    acc.rentRecovered += rentRecovered;
    if (realizedProfit > 0) {
      acc.wins += 1;
    } else if (realizedProfit < 0) {
      acc.losses += 1;
    }
    return acc;
  }, { totalProfit: 0, walletDelta: 0, rentRecovered: 0, wins: 0, losses: 0 });
  const decisionPulse = buildDecisionPulse(logs);
  const processedMints = useRef<Set<string>>(new Set()); // deduplication ref
  const analyzingMints = useRef<Set<string>>(new Set());
  const analysisCooldowns = useRef<Map<string, number>>(new Map());
  const [lastTradeTime, setLastTradeTime] = useState<number>(0);
  const minTimeBetweenTrades = 500;
  const pendingRetries = useRef<Set<string>>(new Set());
  const lastCapacityLogAt = useRef(0);
  const lastRiskPauseLogAt = useRef(0);
  const normalAnalysisCooldownMs = 25000;
  const retryAnalysisCooldownMs = 8000;

  useEffect(() => {
    balanceRef.current = realBalance;
  }, [realBalance]);

  const handleWalletChange = useCallback((newWallet: any) => {
    setWallet(newWallet);
  }, []);

  const handleConfigChange = useCallback((newConfig: any) => {
    setConfig(newConfig);
    setDemoMode(newConfig.isDemo);
  }, [setDemoMode]);

  const onTokenDetected = useCallback(async (token: TokenData, isRetrying = false) => {
    if (!config.isRunning) return;

    const scheduleRetry = (waitTime: number, message: string) => {
      if (pendingRetries.current.has(token.mint)) {
        return;
      }

      pendingRetries.current.add(token.mint);
      addLog(message);
      window.setTimeout(() => onTokenDetected(getLatestToken(token.mint) || token, true), waitTime);
    };

    token = getLatestToken(token.mint) || token;

    if (isRetrying) {
      pendingRetries.current.delete(token.mint);
      addLog(`🔄 Re-analyzing ${token.symbol} (Wait period over)...`);
    }

    const isLiveMicroMode = !config.isDemo && config.mode === 'micro';
    const isLiveGodMode = !config.isDemo && config.mode === 'god';
    const recentLiveTrades = tradeHistory
      .filter((trade) => trade.status === 'closed' && !trade.isPaper && ((Date.now() - (trade.buyTime || 0)) < 20 * 60 * 1000))
      .slice(0, 4);
    let recentLiveLossStreak = 0;
    let recentLiveLossSol = 0;
    for (const trade of recentLiveTrades) {
      const originalCost = trade.originalAmount || trade.amountSolPaid || 0;
      const realizedProfit = trade.realizedPnlSol ?? ((trade.pnlPercent / 100) * originalCost);
      if (realizedProfit < 0) {
        recentLiveLossStreak += 1;
        recentLiveLossSol += realizedProfit;
      } else {
        break;
      }
    }
    const dynamicMinTimeBetweenTrades =
      isLiveGodMode
        ? (recentLiveLossStreak >= 1 ? 240000 : 60000)
        : isLiveMicroMode
          ? (recentLiveLossStreak >= 2 ? 180000 : recentLiveLossStreak >= 1 ? 45000 : 15000)
          : minTimeBetweenTrades;

    if (isLiveGodMode && (recentLiveLossStreak >= 2 || recentLiveLossSol <= -0.003)) {
      addLog(`LIVE GOD HALT: ${recentLiveLossStreak} straight live losses (${recentLiveLossSol.toFixed(4)} SOL). Stopping bot for safety.`);
      setConfig((prev: any) => ({ ...prev, isRunning: false }));
      return;
    }

    if (isLiveMicroMode && (recentLiveLossStreak >= 3 || recentLiveLossSol <= -0.0035)) {
      addLog(`🛑 LIVE MICRO HALT: ${recentLiveLossStreak} straight live losses (${recentLiveLossSol.toFixed(4)} SOL). Stopping bot for safety.`);
      setConfig((prev: any) => ({ ...prev, isRunning: false }));
      return;
    }

    const tokenIdentity = getTokenIdentityKey(token).toLowerCase();
    if (isLiveMicroMode || isLiveGodMode) {
      const recentSameIdentityLoss = tradeHistory.find((trade) => {
        if (trade.status !== 'closed' || trade.isPaper) return false;
        const originalCost = trade.originalAmount || trade.amountSolPaid || 0;
        const realizedProfit = trade.realizedPnlSol ?? ((trade.pnlPercent / 100) * originalCost);
        if (realizedProfit >= 0) return false;
        const sameMint = trade.mint === token.mint;
        const sameIdentity = tokenIdentity && getTokenIdentityKey({ symbol: trade.symbol, name: trade.symbol } as any).toLowerCase() === tokenIdentity;
        return (sameMint || sameIdentity) && (Date.now() - (trade.buyTime || 0)) < 30 * 60 * 1000;
      });
      if (recentSameIdentityLoss) {
        addLog(`LIVE ${isLiveGodMode ? 'GOD' : 'MICRO'} REJECT: ${token.symbol} matches a recent live loser. Skipping repeat entry.`);
        return;
      }
    }

    // 1. DEDUPLICATION (Return if already handled)
    if (processedMints.current.has(token.mint) && !isRetrying) {
      return;
    }

    if (analyzingMints.current.has(token.mint)) {
      return;
    }

    const lastAnalysisAt = analysisCooldowns.current.get(token.mint) || 0;
    const analysisCooldownMs = isRetrying ? retryAnalysisCooldownMs : normalAnalysisCooldownMs;
    if ((Date.now() - lastAnalysisAt) < analysisCooldownMs) {
      return;
    }

    analyzingMints.current.add(token.mint);
    analysisCooldowns.current.set(token.mint, Date.now());

    try {
      // 2. RATE LIMITING & CONCURRENCY (Return but DON'T mark as processed, so we can retry)
      const timeSinceLastTrade = Date.now() - lastTradeTime;
      if (timeSinceLastTrade < dynamicMinTimeBetweenTrades) {
        if ((isLiveMicroMode || isLiveGodMode) && recentLiveLossStreak >= 1) {
          const now = Date.now();
          if ((now - lastRiskPauseLogAt.current) > 15000) {
            addLog(`Live ${isLiveGodMode ? 'god' : 'micro'} cooldown: waiting ${Math.ceil((dynamicMinTimeBetweenTrades - timeSinceLastTrade) / 1000)}s after recent live losses before the next entry.`);
            lastRiskPauseLogAt.current = now;
          }
        }
        return;
      }

      const openTradesCount = activeTrades.filter(t => t.status === "open").length;
      const effectiveMaxConcurrentTrades =
        !config.isDemo && (config.mode === 'micro' || config.mode === 'god')
          ? 1
          : (!config.isDemo && config.mode === 'degen' && realBalance > 0 && realBalance < 0.1
          ? 1
          : (config.maxConcurrentTrades || 1));
      if (openTradesCount >= effectiveMaxConcurrentTrades) {
        const now = Date.now();
        if ((now - lastCapacityLogAt.current) > 15000) {
          addLog(`⏸ Scanner paused: ${openTradesCount}/${config.maxConcurrentTrades || 1} open trades. Waiting for an exit before new entries.`);
          lastCapacityLogAt.current = now;
        }
        return;
      }

      if (!wallet && !config.isDemo) return;

      // Check currently active trades to prevent duplicate positions
      if (activeTrades.some(t => t.mint === token.mint && t.status !== 'closed')) {
        return;
      }

      // === ADVANCED RUG DETECTION (Early Filter) ===
      // This catches obvious scams BEFORE expensive analysis
      const { detectRug } = await import('../utils/rugDetector');
      const rugDetection = detectRug(token, config.mode);

      if (rugDetection.isRug) {
        // Don't log rugs during retries to keep console clean
        if (!isRetrying) {
          addLog(`🚨 RUG DETECTED: ${token.symbol} - ${rugDetection.reason} (Confidence: ${rugDetection.confidence}%)`);
        }
        processedMints.current.add(token.mint); // Finalized as rug
        return;
      }

    // Log warnings but don't reject (for high-risk mode)
      if (rugDetection.warnings.length > 0) {
        rugDetection.warnings.forEach(warning => {
          addLog(`⚠️ ${token.symbol}: ${warning}`);
        });
      }

    // Safety check: Don't buy tokens with suspiciously low liquidity or already crashed
    // Use token data from WebSocket if available (avoids RPC call)
      const liquidity = token.vSolInBondingCurve || 30;
      const liquidityGrowth = liquidity - 30; // Initial liquidity is 30 SOL

      // Reject tokens that have already crashed (negative liquidity growth > 5 SOL)
      if (liquidityGrowth < -5) {
        addLog(`🚨 Rejected ${token.symbol}: Liquidity draining (${liquidityGrowth.toFixed(2)} SOL) - likely rug`);
        return;
      }

    // Reject tokens with very low liquidity (honeypot risk)
      if (liquidity < 1) {
        addLog(`🚨 Rejected ${token.symbol}: Liquidity too low (${liquidity.toFixed(2)} SOL) - honeypot risk`);
        return;
      }

    // For demo mode with RPC issues, use token data from WebSocket directly
    // This allows trading even when RPC is rate-limited
      if (config.isDemo && token.vSolInBondingCurve && token.vTokensInBondingCurve) {
        // We have data from WebSocket, can proceed with analysis using this data
        // The enhanced analyzer will try to fetch more data but can work with what we have
      }

    // Auto-stop if balance is critical (ONLY for real trading with real wallet)
    // Demo mode has its own balance management in usePumpTrader
      const currentBal = balanceRef.current;
      // Reuse timeSinceLastTrade from line 163

      if (!config.isDemo && wallet) {
        if (currentBal === 0) {
          // Flicker protection: If balance is exactly 0, it might be a refresh glitch
          flickerCount.current++;
        } else if (currentBal > 0) {
          flickerCount.current = 0; // Reset on good reading
        }

        const canTrustBalanceReading = currentBal !== -1 && (timeSinceLastTrade >= 10000) && (currentBal > 0 || flickerCount.current >= 3);
        const sizing = fitTradeAmountToBalance(config.amount, currentBal);

        // Only auto-stop if adaptive micro-wallet sizing cannot fit even a minimum viable trade.
        if (canTrustBalanceReading && sizing.fittedAmountSol < MIN_VIABLE_LIVE_TRADE_SOL) {
          addLog(`⚠️ CRITICAL BALANCE: Have ${currentBal.toFixed(4)} SOL, reserve ${sizing.reserveSol.toFixed(4)} SOL leaves only ${sizing.fittedAmountSol.toFixed(4)} SOL tradable. Auto-stopping bot.`);
          setConfig((prev: any) => ({ ...prev, isRunning: false }));
          return;
        }
      }

    // Demo mode: Stop if balance gets too low (prevent burning through all demo SOL)
    if (config.isDemo) {
      // This will be checked in buyToken, but we can add a warning here
      // The actual check happens in usePumpTrader
    }

    // === EXPERIMENTAL PROBE MODE ===
    if (config.mode === 'first') {
      try {
        // Quick pre-filter
        const quickCheck = quickFirstBuyerCheck(token);
        if (!quickCheck.passed) {
          addLog(`🧪 Probe Reject: ${token.symbol} - ${quickCheck.reason}`);
          return;
        }

        // Experimental probe analysis
        const firstSignal = await analyzeFirstBuyer(token, connection);

        if (firstSignal.status === 'wait') {
          scheduleRetry(6000, `⏳ ${token.symbol} probe: ${firstSignal.reason}`);
          return;
        }

        if (!firstSignal.shouldBuy || firstSignal.confidence < 60) {
          addLog(`🧪 Probe Reject: ${token.symbol} - ${firstSignal.reason} (Confidence: ${firstSignal.confidence}%)`);
          return;
        }

        // Log probe signal
        addLog(`🧪 EARLY PROBE: ${token.symbol} - ${firstSignal.reason}`);
        addLog(`   Confidence: ${firstSignal.confidence}% | Entry Time: ${new Date(firstSignal.entryTime).toLocaleTimeString()}`);
        const tp2Text = firstSignal.exitStrategy.takeProfit2 ? ` | TP2 ${firstSignal.exitStrategy.takeProfit2}%` : '';
        addLog(`   Exit Strategy: ${firstSignal.exitStrategy.timeBasedExit}s max hold | TP ${firstSignal.exitStrategy.takeProfit}%${tp2Text} | SL ${firstSignal.exitStrategy.stopLoss}%`);

        // Calculate initial price from token data
        // Demo mode uses REAL tokens, so always calculate from real token data
        let initialPrice: number | undefined;
        if (token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0) {
          initialPrice = calculatePumpPrice(token.vSolInBondingCurve, token.vTokensInBondingCurve);
        } else {
          // Price will be fetched from blockchain in buyToken if not available here
          initialPrice = undefined;
        }

        // Convert first buyer exit strategy to ActiveTrade format
        const exitStrategy = {
          takeProfit: firstSignal.exitStrategy.takeProfit,
          takeProfit2: firstSignal.exitStrategy.takeProfit2,
          stopLoss: firstSignal.exitStrategy.stopLoss,
          maxHoldTime: firstSignal.exitStrategy.timeBasedExit,
          trailingStop: false,
          momentumExit: firstSignal.exitStrategy.momentumExit,
          minHoldTime: firstSignal.exitStrategy.minHoldTime
        };

        // Use small probe size from the analyzer
        const tradeAmount = firstSignal.exitStrategy.positionSize || config.amount;
        addLog(`   💰 Position Size: ${tradeAmount} SOL (probe-sized)`);

        // Buy with fast probe exits
        setLastTradeTime(Date.now());
        await buyToken(token.mint, token.symbol, tradeAmount, 15, initialPrice, exitStrategy);
        return;
      } catch (error: any) {
        addLog(`❌ Probe Error for ${token.symbol}: ${error.message}`);
        return;
      }
    }

    // === AGGRESSIVE CONTINUATION MODE (SCALP) ===
    if (config.mode === 'scalp') {
      try {
        // Quick pre-filter
        const quickCheck = quickSpeedCheck(token);
        if (!quickCheck.passed) {
          addLog(`🔥 Aggressive Reject: ${token.symbol} - ${quickCheck.reason}`);
          return;
        }

        // Aggressive continuation analysis
        const speedSignal = await analyzeSpeedTrade(token, connection);

        if (speedSignal.status === 'wait') {
          scheduleRetry(5000, `⏳ ${token.symbol} aggressive continuation: ${speedSignal.reason}`);
          return;
        }

        if (!speedSignal.shouldBuy || speedSignal.confidence < 50) {
          addLog(`🔥 Aggressive Reject: ${token.symbol} - ${speedSignal.reason} (Confidence: ${speedSignal.confidence}%)`);
          return;
        }

        // Log aggressive continuation signal
        addLog(`🔥 AGGRESSIVE BUY: ${token.symbol} - ${speedSignal.reason}`);
        addLog(`   Confidence: ${speedSignal.confidence}% | Momentum: ${speedSignal.momentum.toFixed(2)} SOL/min`);
        addLog(`   Exit Strategy: TP ${speedSignal.exitStrategy.takeProfit}% | SL ${speedSignal.exitStrategy.stopLoss}% | Max Hold: ${speedSignal.exitStrategy.maxHoldTime}s`);

        // Calculate initial price from token data
        // Demo mode uses REAL tokens, so always calculate from real token data
        let initialPrice: number | undefined;
        if (token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0) {
          initialPrice = calculatePumpPrice(token.vSolInBondingCurve, token.vTokensInBondingCurve);
        } else {
          // Price will be fetched from blockchain in buyToken if not available here
          initialPrice = undefined;
        }

        // Buy with exit strategy
        setLastTradeTime(Date.now());
        await buyToken(token.mint, token.symbol, config.amount, 15, initialPrice, speedSignal.exitStrategy);
        return;
      } catch (error: any) {
        addLog(`❌ Aggressive Continuation Error for ${token.symbol}: ${error.message}`);
        return;
      }
    }

    // === HIGH RISK MODE: MOMENTUM-BASED FAST TRACK ===
    // For High Risk mode, prioritize new tokens with fast momentum
    // BUT: Still respect rug detection - don't buy obvious scams!
    if (config.mode === 'high') {
      try {
        const age = getTokenAgeSeconds(token);
        const liquidityGrowth = (token.vSolInBondingCurve || 30) - 30;

        // Calculate momentum (liquidity growth rate)
        const momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0; // SOL per minute

        // FAST TRACK: Very new tokens (<60s) with strong momentum
        // BUT: Must pass basic rug checks (liquidity, not crashed, etc.)
        if (age < 60 && momentum > 1.5 && liquidityGrowth > 2 && liquidityGrowth >= 0 && (token.vSolInBondingCurve || 30) >= 1) {
          addLog(`🚀 HIGH RISK FAST TRACK: ${token.symbol} - ${age.toFixed(0)}s old, ${momentum.toFixed(1)} SOL/min momentum, +${liquidityGrowth.toFixed(2)} SOL`);
          addLog(`   ⚡ NEW + MOMENTUM: Early momentum play (rug checks passed)`);

          // TREND VERIFICATION (Anti-Falling Knife)
          addLog(`🔎 Verifying trend for ${token.symbol}...`);
          await new Promise(r => setTimeout(r, 1500));
          const freshData = await getPumpData(token.mint, connection);
          if (!freshData) { addLog(`⚠️ Verification failed for ${token.symbol}`); return; }

          const freshPrice = calculatePumpPrice(freshData.vSolInBondingCurve, freshData.vTokensInBondingCurve);
          const oldPrice = calculatePumpPrice(token.vSolInBondingCurve || 30, token.vTokensInBondingCurve || 1_073_000_000);
          const change = ((freshPrice - oldPrice) / oldPrice) * 100;

          if (change < -0.5) {
            addLog(`📉 FALLING KNIFE: ${token.symbol} dropped ${change.toFixed(2)}% in 1.5s. Rejected.`);
            return;
          }
          if (freshData.vSolInBondingCurve < (token.vSolInBondingCurve || 30) * 0.9) {
            addLog(`📉 LIQUIDITY DRAIN: ${token.symbol} liquidity dropped. Rejected.`);
            return;
          }
          addLog(`✅ Trend Valid: ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`);

          // Update for accurate entry price
          token.vSolInBondingCurve = freshData.vSolInBondingCurve;
          token.vTokensInBondingCurve = freshData.vTokensInBondingCurve;

          addLog(`   High mode candidate verified. Running shared aggressive analysis next.`);
        }

        // FAST TRACK: New tokens (<2 min) with very strong momentum (>3 SOL/min)
        // BUT: Must pass basic rug checks
        if (age < 120 && momentum > 3 && liquidityGrowth > 5 && liquidityGrowth >= 0 && (token.vSolInBondingCurve || 30) >= 1) {
          addLog(`🚀 HIGH RISK FAST TRACK: ${token.symbol} - ${age.toFixed(0)}s old, ${momentum.toFixed(1)} SOL/min momentum, +${liquidityGrowth.toFixed(2)} SOL`);
          addLog(`   ⚡ STRONG MOMENTUM: High buy activity detected (rug checks passed)`);

          // TREND VERIFICATION (Anti-Falling Knife)
          addLog(`🔎 Verifying trend for ${token.symbol}...`);
          await new Promise(r => setTimeout(r, 1500));
          const freshData = await getPumpData(token.mint, connection);
          if (!freshData) { addLog(`⚠️ Verification failed for ${token.symbol}`); return; }

          const freshPrice = calculatePumpPrice(freshData.vSolInBondingCurve, freshData.vTokensInBondingCurve);
          const oldPrice = calculatePumpPrice(token.vSolInBondingCurve || 30, token.vTokensInBondingCurve || 1_073_000_000);
          const change = ((freshPrice - oldPrice) / oldPrice) * 100;

          if (change < -0.5) {
            addLog(`📉 FALLING KNIFE: ${token.symbol} dropped ${change.toFixed(2)}% in 1.5s. Rejected.`);
            return;
          }
          addLog(`✅ Trend Valid: ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`);

          token.vSolInBondingCurve = freshData.vSolInBondingCurve;
          token.vTokensInBondingCurve = freshData.vTokensInBondingCurve;

          addLog(`   High mode candidate verified. Running shared aggressive analysis next.`);
        }
      } catch (error: any) {
        // If fast track fails, fall through to normal analysis
        addLog(`⚠️ Fast track error for ${token.symbol}, using normal analysis: ${error.message}`);
      }
    }

    // === VELOCITY MODE: MOMENTUM FAST TRACK ===
    if (config.mode === 'velocity') {
      try {
        const age = getTokenAgeSeconds(token);
        const liquidityGrowth = (token.vSolInBondingCurve || 30) - 30;
        const momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0;

        // VELOCITY FAST TRACK: New tokens (<60s) with explosive initial volume
        // PLUS BASIC RUG CHECK: Don't buy obvious scams even if they are fast
        const isObviousRug = token.name.toLowerCase().includes("rug") ||
          token.name.toLowerCase().includes("test") ||
          token.symbol.toLowerCase().includes("rug");

        if (!isObviousRug && age < 60 && momentum > 1.0 && liquidityGrowth > 1.5 && (token.vSolInBondingCurve || 30) >= 1) {
          addLog(`🏎️ VELOCITY FAST TRACK: ${token.symbol} - ${age.toFixed(0)}s old, ${momentum.toFixed(1)} SOL/min momentum`);
          addLog(`   🎯 EARLY IGNITION: Token is launching with conviction. Entering trade.`);

          // TREND VERIFICATION
          addLog(`🔎 Verifying Velocity Trend for ${token.symbol}...`);
          await new Promise(r => setTimeout(r, 1500));
          const freshData = await getPumpData(token.mint, connection);
          if (!freshData) { addLog(`⚠️ Verification failed for ${token.symbol}`); return; }

        const freshPrice = calculatePumpPrice(freshData.vSolInBondingCurve, freshData.vTokensInBondingCurve);
        const oldPrice = calculatePumpPrice(token.vSolInBondingCurve || 30, token.vTokensInBondingCurve || 1_073_000_000);
          const change = ((freshPrice - oldPrice) / oldPrice) * 100;

          if (change < -0.5) {
            addLog(`📉 FALLING KNIFE: ${token.symbol} dropped ${change.toFixed(2)}%. Velocity Reject.`);
            return;
          }
          addLog(`✅ Velocity Valid: ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`);

          token.vSolInBondingCurve = freshData.vSolInBondingCurve;
          token.vTokensInBondingCurve = freshData.vTokensInBondingCurve;

          addLog(`   Velocity candidate verified. Running shared aggressive analysis next.`);
        }
      } catch (e) { }
    }

    if (config.mode === 'micro') {
      try {
        const age = getTokenAgeSeconds(token);
        const liquidity = token.vSolInBondingCurve || 30;
        const liquidityGrowth = liquidity - 30;
        const momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0;
        const liveWalletBalance = balanceRef.current;
        const isLiveMicro = !config.isDemo;
        const isLiveMicroWallet = !config.isDemo && isMicroWalletBalance(liveWalletBalance);
        const snapshot = getMarketSnapshot(token.mint);
        const tradeCount = snapshot?.tradeCount || 0;
        const buyCount = snapshot?.buyCount || 0;
        const sellCount = snapshot?.sellCount || 0;
        const uniqueTraderCount = snapshot?.uniqueTraderCount || 0;
        const observedVolume = snapshot?.observedVolumeSol || Math.max(0, liquidityGrowth);
        const buyPressure = snapshot?.buyPressure ?? 0;
        const netFlow = snapshot?.netFlowSol ?? liquidityGrowth;
        const priceChangePercent = snapshot?.priceChangePercent || 0;
        const traderDiversity = calculateTraderDiversity(uniqueTraderCount, tradeCount);
        const bondingCurveProgress = calculateBondingCurveProgress(token.vTokensInBondingCurve);
        const observedSeconds = snapshot
          ? Math.max(0, (snapshot.lastSeenAt - snapshot.firstSeenAt) / 1000)
          : age;
        const capitalEfficiency = observedVolume / Math.max(1, tradeCount);
        const netFlowVelocity = age > 0 ? (netFlow / age) * 60 : 0;
        const curveVelocity = age > 0 ? (bondingCurveProgress / age) * 60 : 0;
        const runnerVelocityScore = calculateMicroVelocityScore({
          age,
          observedVolume,
          tradeCount,
          uniqueTraderCount,
          buyPressure,
          netFlow,
          bondingCurveProgress,
          sellCount,
          priceChangePercent
        });
        const velocityScoreFloor = isLiveMicro ? 64 : (isLiveMicroWallet ? 50 : 56);
        const capitalEfficiencyFloor = isLiveMicro ? 0.07 : (isLiveMicroWallet ? 0.045 : 0.06);
        const capitalEfficiencyCeiling = isLiveMicro ? 0.9 : (isLiveMicroWallet ? 1.15 : 1.0);
        const minAgeSeconds = isLiveMicro ? 26 : (isLiveMicroWallet ? 18 : 22);
        const minObservedSeconds = isLiveMicro ? 18 : (isLiveMicroWallet ? 12 : 15);
        const minTradeCount = isLiveMicro ? 10 : (isLiveMicroWallet ? 6 : 8);
        const minUniqueTraders = isLiveMicro ? 7 : (isLiveMicroWallet ? 5 : 6);
        const minObservedVolume = isLiveMicro ? 0.95 : (isLiveMicroWallet ? 0.45 : 0.65);
        const reclaimPressureFloor = isLiveMicro ? 0.58 : (isLiveMicroWallet ? 0.54 : 0.56);
        const reclaimNetFlowFloor = isLiveMicro ? 0.28 : (isLiveMicroWallet ? 0.12 : 0.22);
        const reclaimDiversityFloor = isLiveMicro ? 0.52 : (isLiveMicroWallet ? 0.4 : 0.48);
        const minPriceExpansion = isLiveMicro ? 10 : (isLiveMicroWallet ? 5 : 8);
        const maxPriceExpansion = isLiveMicro ? 85 : (isLiveMicroWallet ? 110 : 95);
        const minCurveProgress = isLiveMicro ? 1.0 : (isLiveMicroWallet ? 0.5 : 0.75);
        const maxCurveProgress = isLiveMicro ? 14 : 16;
        const maxSellCount = Math.max(2, Math.floor(tradeCount * (isLiveMicro ? 0.38 : 0.42)));
        const velocityReady =
          runnerVelocityScore >= velocityScoreFloor &&
          capitalEfficiency >= capitalEfficiencyFloor &&
          capitalEfficiency <= capitalEfficiencyCeiling &&
          curveVelocity >= (isLiveMicro ? 0.55 : (isLiveMicroWallet ? 0.32 : 0.42)) &&
          netFlowVelocity >= (isLiveMicro ? 0.2 : (isLiveMicroWallet ? 0.1 : 0.16));
        const sampleTooThin = tradeCount < minTradeCount || uniqueTraderCount < minUniqueTraders || observedSeconds < minObservedSeconds;
        const needsMoreAge = age < minAgeSeconds;
        const reclaimStructureReady =
          observedVolume >= minObservedVolume &&
          buyPressure >= reclaimPressureFloor &&
          netFlow >= reclaimNetFlowFloor &&
          traderDiversity >= reclaimDiversityFloor &&
          priceChangePercent >= minPriceExpansion &&
          priceChangePercent <= maxPriceExpansion &&
          bondingCurveProgress >= minCurveProgress &&
          bondingCurveProgress <= maxCurveProgress;
        const pullbackConfirmed =
          sellCount >= 1 &&
          sellCount <= maxSellCount &&
          buyCount > sellCount &&
          (snapshot?.lastTradeType === 'buy' || buyPressure >= reclaimPressureFloor + 0.03);
        const syntheticTape =
          (tradeCount <= 4 && capitalEfficiency > 0.35) ||
          (tradeCount <= 6 && capitalEfficiency > 0.6) ||
          capitalEfficiency > capitalEfficiencyCeiling ||
          (priceChangePercent < minPriceExpansion && sellCount === 0 && buyPressure > 0.85) ||
          (tradeCount > 0 && uniqueTraderCount > tradeCount + 2);
        const reversalActive =
          tradeCount >= Math.max(4, minTradeCount - 2) &&
          (
            sellCount > buyCount ||
            buyPressure < (reclaimPressureFloor - 0.08) ||
            netFlow <= Math.max(0.05, reclaimNetFlowFloor * 0.35) ||
            priceChangePercent <= -4
          );
        const pristineLaunch =
          age < minAgeSeconds &&
          tradeCount === 0 &&
          buyCount === 0 &&
          sellCount === 0 &&
          uniqueTraderCount <= 1 &&
          observedVolume <= (isLiveMicroWallet ? 0.08 : 0.12);

        if (pristineLaunch) {
          return;
        }

        if (needsMoreAge || sampleTooThin) {
          scheduleRetry(5000, `MICRO wait: ${token.symbol} needs more history before reclaim entry (${tradeCount} trades, ${uniqueTraderCount} wallets, ${age.toFixed(0)}s age).`);
          return;
        }

        if (syntheticTape) {
          addLog(`MICRO Reject: ${token.symbol} flow looks synthetic or too concentrated (${tradeCount} trades, ${uniqueTraderCount} wallets, eff ${capitalEfficiency.toFixed(3)}).`);
          return;
        }

        if (reversalActive) {
          if (age < 150) {
            scheduleRetry(5000, `MICRO wait: ${token.symbol} reclaim is not stable yet (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, price ${priceChangePercent.toFixed(1)}%).`);
          } else {
            addLog(`MICRO Reject: ${token.symbol} never stabilized after the first dump (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, price ${priceChangePercent.toFixed(1)}%).`);
          }
          return;
        }

        if (!pullbackConfirmed) {
          if (sellCount === 0) {
            scheduleRetry(5000, `MICRO wait: ${token.symbol} has not shown a real pullback yet (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure).`);
          } else {
            scheduleRetry(5000, `MICRO wait: ${token.symbol} needs a cleaner reclaim after the pullback (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure).`);
          }
          return;
        }

        if (!reclaimStructureReady || !velocityReady) {
          if (age < 150) {
            scheduleRetry(5000, `MICRO wait: ${token.symbol} needs cleaner reclaim structure (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, vel ${runnerVelocityScore}, eff ${capitalEfficiency.toFixed(3)}).`);
          } else {
            addLog(`MICRO Reject: ${token.symbol} reclaim never reached tradeable quality (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, vel ${runnerVelocityScore}, eff ${capitalEfficiency.toFixed(3)}).`);
          }
          return;
        }

        addLog(`MICRO reclaim setup: ${token.symbol} - flow ${tradeCount} trades | ${(buyPressure * 100).toFixed(0)}% buy pressure | curve ${bondingCurveProgress.toFixed(1)}% | price ${priceChangePercent.toFixed(1)}% | diversity ${(traderDiversity * 100).toFixed(0)}% | vel ${runnerVelocityScore} | eff ${capitalEfficiency.toFixed(3)}`);
        const aggressiveSetup =
          buyPressure >= (reclaimPressureFloor + 0.08) &&
          buyCount >= Math.max(minTradeCount - 2, sellCount + 4) &&
          tradeCount >= (minTradeCount + 4) &&
          uniqueTraderCount >= (minUniqueTraders + 2) &&
          observedVolume >= (minObservedVolume + (isLiveMicroWallet ? 0.2 : 0.45)) &&
          netFlow > (reclaimNetFlowFloor + (isLiveMicroWallet ? 0.12 : 0.2)) &&
          priceChangePercent >= (minPriceExpansion + 2) &&
          priceChangePercent <= (maxPriceExpansion - 12) &&
          traderDiversity >= (reclaimDiversityFloor + 0.05) &&
          capitalEfficiency <= (capitalEfficiencyCeiling * 0.8);
        const setupPrice = token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0
          ? calculatePumpPrice(token.vSolInBondingCurve, token.vTokensInBondingCurve)
          : 0;
        const verificationDelayMs = isLiveMicroWallet
          ? (aggressiveSetup ? 1000 : 1400)
          : (aggressiveSetup ? 1600 : 2200);
        await new Promise(r => setTimeout(r, verificationDelayMs));
        const verificationSnapshot = getMarketSnapshot(token.mint);
        const freshData = await getPumpData(token.mint, connection);
        if (!freshData) {
          const verificationTradeCount = verificationSnapshot?.tradeCount ?? tradeCount;
          const verificationUniqueTraderCount = verificationSnapshot?.uniqueTraderCount ?? uniqueTraderCount;
          const verificationObservedVolume = verificationSnapshot?.observedVolumeSol ?? observedVolume;
          const verificationBuyPressure = verificationSnapshot?.buyPressure ?? buyPressure;
          const verificationNetFlow = verificationSnapshot?.netFlowSol ?? netFlow;
          const verificationTraderDiversity = calculateTraderDiversity(verificationUniqueTraderCount, verificationTradeCount);
          const hasFeedVerification =
            verificationTradeCount >= tradeCount + 1 &&
            verificationUniqueTraderCount >= minUniqueTraders &&
            verificationObservedVolume >= minObservedVolume &&
            verificationBuyPressure >= reclaimPressureFloor &&
            verificationNetFlow >= reclaimNetFlowFloor &&
            verificationTraderDiversity >= reclaimDiversityFloor &&
            verificationSnapshot?.lastTradeType === 'buy';

          if (!hasFeedVerification) {
            scheduleRetry(5000, `MICRO wait: ${token.symbol} reclaim verification snapshot unavailable.`);
            return;
          }

          addLog(`MICRO fallback: ${token.symbol} using live feed reclaim verification while RPC snapshot is unavailable.`);
        }

        const verifiedLiquidity = freshData?.vSolInBondingCurve || liquidity;
        const verifiedCurveProgress = Number.isFinite(freshData?.bondingCurveProgress)
          ? freshData!.bondingCurveProgress
          : bondingCurveProgress;
        const verifiedTokens = freshData?.vTokensInBondingCurve || token.vTokensInBondingCurve;
        const verifiedPrice = verifiedLiquidity > 0 && verifiedTokens > 0
          ? calculatePumpPrice(verifiedLiquidity, verifiedTokens)
          : setupPrice;
        const verificationTradeCount = verificationSnapshot?.tradeCount ?? tradeCount;
        const verificationBuyCount = verificationSnapshot?.buyCount ?? buyCount;
        const verificationSellCount = verificationSnapshot?.sellCount ?? sellCount;
        const verificationUniqueTraderCount = verificationSnapshot?.uniqueTraderCount ?? uniqueTraderCount;
        const verificationObservedVolume = verificationSnapshot?.observedVolumeSol ?? observedVolume;
        const verificationBuyPressure = verificationSnapshot?.buyPressure ?? buyPressure;
        const verificationNetFlow = verificationSnapshot?.netFlowSol ?? netFlow;
        const verificationPriceChangePercent = verificationSnapshot?.priceChangePercent ?? priceChangePercent;
        const verificationLastTradeType = verificationSnapshot?.lastTradeType ?? snapshot?.lastTradeType;
        const verificationTraderDiversity = calculateTraderDiversity(verificationUniqueTraderCount, verificationTradeCount);
        const verificationVelocityScore = calculateMicroVelocityScore({
          age: Math.max(age, observedSeconds),
          observedVolume: verificationObservedVolume,
          tradeCount: verificationTradeCount,
          uniqueTraderCount: verificationUniqueTraderCount,
          buyPressure: verificationBuyPressure,
          netFlow: verificationNetFlow,
          bondingCurveProgress: verifiedCurveProgress,
          sellCount: verificationSellCount,
          priceChangePercent: verificationPriceChangePercent
        });

        if (verifiedLiquidity <= 0) {
          scheduleRetry(5000, `MICRO wait: ${token.symbol} verification liquidity unavailable.`);
          return;
        }

        if (freshData) {
          const liquidityDeltaPercent = liquidity > 0 ? ((verifiedLiquidity - liquidity) / liquidity) * 100 : 0;
          const curveDelta = verifiedCurveProgress - bondingCurveProgress;
          const priceDeltaPercent = setupPrice > 0 && verifiedPrice > 0
            ? ((verifiedPrice - setupPrice) / setupPrice) * 100
            : 0;
          const tradeDelta = verificationTradeCount - tradeCount;
          const buyDelta = verificationBuyCount - buyCount;
          const sellDelta = verificationSellCount - sellCount;

          if (
            liquidityDeltaPercent < (isLiveMicro ? -4 : (isLiveMicroWallet ? -6 : -5)) ||
            curveDelta < (isLiveMicro ? -1.2 : (isLiveMicroWallet ? -1.8 : -1.5)) ||
            priceDeltaPercent < (isLiveMicro ? -2.2 : (isLiveMicroWallet ? -3.2 : -2.8)) ||
            verificationBuyPressure < reclaimPressureFloor ||
            verificationNetFlow < reclaimNetFlowFloor ||
            verificationTraderDiversity < reclaimDiversityFloor ||
            verificationVelocityScore < velocityScoreFloor ||
            verificationLastTradeType === 'sell' ||
            tradeDelta < 1 ||
            buyDelta < Math.max(1, sellDelta)
          ) {
            addLog(`MICRO Reject: ${token.symbol} reclaim failed verification (${liquidityDeltaPercent.toFixed(1)}% liquidity, ${curveDelta.toFixed(1)} curve pts, ${priceDeltaPercent.toFixed(1)}% price, ${tradeDelta} fresh trades).`);
            return;
          }
          if (
            liquidityDeltaPercent < (isLiveMicro ? -1.5 : (isLiveMicroWallet ? -2.5 : -2)) ||
            curveDelta < (isLiveMicro ? -0.4 : (isLiveMicroWallet ? -0.7 : -0.5)) ||
            priceDeltaPercent < (isLiveMicro ? -0.8 : (isLiveMicroWallet ? -1.4 : -1.1)) ||
            priceDeltaPercent > (isLiveMicro ? 6.5 : (isLiveMicroWallet ? 10 : 8.5))
          ) {
            scheduleRetry(5000, `MICRO wait: ${token.symbol} reclaim is still resolving (${liquidityDeltaPercent.toFixed(1)}% liquidity, ${curveDelta.toFixed(1)} curve pts, ${priceDeltaPercent.toFixed(1)}% price).`);
            return;
          }
          if (
            verificationTradeCount < minTradeCount ||
            verificationUniqueTraderCount < minUniqueTraders ||
            verificationObservedVolume < minObservedVolume
          ) {
            scheduleRetry(5000, `MICRO wait: ${token.symbol} reclaim still needs broader participation (${verificationTradeCount} trades, ${verificationUniqueTraderCount} wallets).`);
            return;
          }
        }

        token.vSolInBondingCurve = verifiedLiquidity;
        token.vTokensInBondingCurve = verifiedTokens;

        const initialPrice = token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0
          ? calculatePumpPrice(token.vSolInBondingCurve, token.vTokensInBondingCurve)
          : undefined;

        const microSizeMultiplier = isLiveMicro
          ? (aggressiveSetup ? 0.58 : 0.46)
          : (aggressiveSetup ? 0.82 : 0.65);
        const microAmount = Number(Math.max(config.amount * (isLiveMicro ? 0.38 : 0.48), config.amount * microSizeMultiplier).toFixed(4));
        const stagedEntryFraction = isLiveMicro ? (aggressiveSetup ? 0.52 : 0.42) : (aggressiveSetup ? 0.62 : 0.5);
        const starterAmount = Number((microAmount * stagedEntryFraction).toFixed(4));
        const scaleInAmount = Number(Math.max(0, microAmount - starterAmount).toFixed(4));
        const exitStrategy = {
          takeProfit: Math.min(config.takeProfit, isLiveMicro ? (aggressiveSetup ? 10 : 11) : (aggressiveSetup ? 13 : 14)),
          takeProfit2: isLiveMicro ? (aggressiveSetup ? 22 : 18) : (aggressiveSetup ? 32 : 26),
          stopLoss: Math.min(config.stopLoss, isLiveMicro ? (aggressiveSetup ? 2.8 : 3.2) : (aggressiveSetup ? 3.8 : 4.2)),
          maxHoldTime: isLiveMicro ? (aggressiveSetup ? 28 : 34) : (aggressiveSetup ? 55 : 65),
          trailingStop: false,
          momentumExit: false,
          minHoldTime: isLiveMicro ? 6 : 8,
          fastKillLoss: isLiveMicro ? (aggressiveSetup ? 1.9 : 2.3) : (aggressiveSetup ? 2.6 : 3.0),
          fastKillSeconds: isLiveMicro ? (aggressiveSetup ? 3 : 4) : (aggressiveSetup ? 5 : 6),
          givebackPeakTrigger: isLiveMicro ? (aggressiveSetup ? 2.8 : 3.5) : (aggressiveSetup ? 4.5 : 5.2),
          givebackFloor: isLiveMicro ? 0.8 : (aggressiveSetup ? 0.3 : 0),
          givebackSeconds: isLiveMicro ? (aggressiveSetup ? 6 : 8) : (aggressiveSetup ? 10 : 12),
          stagnationSeconds: isLiveMicro ? (aggressiveSetup ? 10 : 12) : (aggressiveSetup ? 18 : 22),
          stagnationFloor: isLiveMicro ? (aggressiveSetup ? -0.4 : -0.8) : (aggressiveSetup ? -0.4 : -0.6),
          tp1SellPercent: isLiveMicro ? 85 : 80,
          tp2SellPercent: 10,
          postTp1FloorPercent: isLiveMicro ? 0.5 : 0,
          postTp2FloorPercent: isLiveMicro ? (aggressiveSetup ? 4 : 3) : (aggressiveSetup ? 8 : 5),
          runnerMaxHoldTime: isLiveMicro ? (aggressiveSetup ? 150 : 120) : (aggressiveSetup ? 360 : 300),
          runnerTrailingStopPercent: isLiveMicro ? (aggressiveSetup ? 11 : 9) : (aggressiveSetup ? 15 : 13),
          runnerActivationProfit: isLiveMicro ? (aggressiveSetup ? 12 : 10) : (aggressiveSetup ? 22 : 18),
          runnerTimeExitFloor: isLiveMicro ? (aggressiveSetup ? 4 : 3) : (aggressiveSetup ? 8 : 6)
        };
        const scaleInPlan = scaleInAmount >= 0.001 && aggressiveSetup ? {
          pendingSol: scaleInAmount,
          triggerPnlPercent: isLiveMicro ? 4.5 : 5.5,
          requiredObservedVolumeSol: Number((verificationObservedVolume + (isLiveMicro ? 0.18 : (isLiveMicroWallet ? 0.12 : 0.25))).toFixed(3)),
          requiredUniqueTraderCount: verificationUniqueTraderCount + 1,
          requiredBuyPressure: Number(Math.max(reclaimPressureFloor + 0.02, verificationBuyPressure).toFixed(2)),
          maxWaitSeconds: isLiveMicro ? 16 : 24,
          inFlight: false,
          completed: false,
          expired: false
        } : undefined;
        const microSlippage = isLiveMicro
          ? Math.min(config.advanced?.slippage || 18, aggressiveSetup ? 16 : 14)
          : Math.max(config.advanced?.slippage || 25, aggressiveSetup ? 30 : (isLiveMicroWallet ? 28 : 26));

        setLastTradeTime(Date.now());
        if (scaleInPlan) {
          addLog(`MICRO staged reclaim: ${token.symbol} starting with ${starterAmount.toFixed(4)} SOL, add-on ${scaleInAmount.toFixed(4)} SOL only if the second leg confirms.`);
        }
        await buyToken(token.mint, token.symbol, scaleInPlan ? starterAmount : microAmount, microSlippage, initialPrice, exitStrategy, scaleInPlan ? { scaleInPlan } : undefined);
        return;
      } catch (error: any) {
        addLog(`MICRO error for ${token.symbol}: ${error.message}`);
        return;
      }
    }

    if (config.mode === 'god') {
      try {
        const age = getTokenAgeSeconds(token);
        const liquidity = token.vSolInBondingCurve || 30;
        const liquidityGrowth = liquidity - 30;
        const momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0;
        const snapshot = getMarketSnapshot(token.mint);
        const tradeCount = snapshot?.tradeCount || 0;
        const buyCount = snapshot?.buyCount || 0;
        const sellCount = snapshot?.sellCount || 0;
        const uniqueTraderCount = snapshot?.uniqueTraderCount || 0;
        const observedVolume = snapshot?.observedVolumeSol || Math.max(0, liquidityGrowth);
        const buyPressure = snapshot?.buyPressure ?? 0;
        const netFlow = snapshot?.netFlowSol ?? liquidityGrowth;
        const priceChangePercent = snapshot?.priceChangePercent || 0;
        const largestTraderVolumeShare = snapshot?.largestTraderVolumeShare || 0;
        const topTwoTraderVolumeShare = snapshot?.topTwoTraderVolumeShare || 0;
        const creatorVolumeShare = snapshot?.creatorVolumeShare || 0;
        const creatorSellCount = snapshot?.creatorSellCount || 0;
        const traderDiversity = calculateTraderDiversity(uniqueTraderCount, tradeCount);
        const bondingCurveProgress = calculateBondingCurveProgress(token.vTokensInBondingCurve);
        const curveVelocity = age > 0 ? (bondingCurveProgress / age) * 60 : 0;
        const capitalEfficiency = observedVolume / Math.max(1, tradeCount);
        const stressBuySizeSol = config.isDemo ? 0.35 : Math.max(0.25, Math.min(0.5, config.amount * 40));
        const stressImpactPercent = estimateCurveBuyImpactPercent(liquidity, stressBuySizeSol);
        const waitingOnSnapshot =
          age <= 30 &&
          tradeCount === 0 &&
          observedVolume <= 0.2 &&
          liquidityGrowth > 0.3;
        const hardExtendedReject =
          age > (config.isDemo ? 220 : 180) ||
          priceChangePercent >= (config.isDemo ? 42 : 36) ||
          bondingCurveProgress >= (config.isDemo ? 22 : 18) ||
          tradeCount >= (config.isDemo ? 140 : 110);
        const reclaimWatchTriggered =
          !hardExtendedReject &&
          (
            priceChangePercent >= (config.isDemo ? 16 : 14) ||
            bondingCurveProgress >= (config.isDemo ? 12 : 11) ||
            tradeCount >= (config.isDemo ? 32 : 26)
          );
        const reclaimStructureReady =
          reclaimWatchTriggered &&
          age >= 18 &&
          age <= (config.isDemo ? 160 : 140) &&
          sellCount >= 1 &&
          tradeCount >= (config.isDemo ? 8 : 8) &&
          uniqueTraderCount >= (config.isDemo ? 6 : 6) &&
          observedVolume >= (config.isDemo ? 1.2 : 1.25) &&
          buyPressure >= (config.isDemo ? 0.56 : 0.58) &&
          buyPressure <= (config.isDemo ? 0.9 : 0.92) &&
          netFlow >= (config.isDemo ? 0.28 : 0.28) &&
          traderDiversity >= (config.isDemo ? 0.42 : 0.42) &&
          capitalEfficiency >= (config.isDemo ? 0.075 : 0.08) &&
          stressImpactPercent <= (config.isDemo ? 2.2 : 1.8) &&
          curveVelocity >= (config.isDemo ? 0.45 : 0.55) &&
          curveVelocity <= (config.isDemo ? 10 : 10);
        const reclaimLaneActive = reclaimWatchTriggered && reclaimStructureReady;

        if (age < 6) {
          scheduleRetry(4000, `GOD wait: ${token.symbol} is still in the opening chaos (${age.toFixed(1)}s old).`);
          return;
        }

        if (creatorSellCount > 0 && age <= 180) {
          addLog(`GOD Reject: ${token.symbol} creator already sold into the launch (${creatorSellCount} sell${creatorSellCount === 1 ? '' : 's'}).`);
          return;
        }

        if (hardExtendedReject) {
          addLog(`GOD Reject: ${token.symbol} is already too extended (price ${priceChangePercent.toFixed(1)}%, curve ${bondingCurveProgress.toFixed(1)}%, trades ${tradeCount}, age ${age.toFixed(0)}s).`);
          return;
        }

        const staleRunnerReject =
          age >= 110 &&
          bondingCurveProgress < 6.5 &&
          priceChangePercent < 18 &&
          (observedVolume < 5 || netFlow < 3.6);

        if (staleRunnerReject) {
          addLog(`GOD Reject: ${token.symbol} stayed too stale for conservative mode (price ${priceChangePercent.toFixed(1)}%, curve ${bondingCurveProgress.toFixed(1)}%, age ${age.toFixed(0)}s).`);
          return;
        }

        if (reclaimWatchTriggered && !reclaimLaneActive) {
          if (age < (config.isDemo ? 160 : 140)) {
            scheduleRetry(
              6000,
              `GOD wait: ${token.symbol} extended cleanly; watching for a calmer reclaim (${tradeCount} trades, ${sellCount} sells, curve ${bondingCurveProgress.toFixed(1)}%).`
            );
          } else {
            addLog(`GOD Reject: ${token.symbol} extended early but never settled into a conservative reclaim.`);
          }
          return;
        }

        const godMaxLargestTraderShare = reclaimLaneActive ? (config.isDemo ? 0.4 : 0.38) : (config.isDemo ? 0.34 : 0.3);
        const godMaxTopTwoTraderShare = reclaimLaneActive ? (config.isDemo ? 0.58 : 0.56) : (config.isDemo ? 0.55 : 0.48);

        if (largestTraderVolumeShare > godMaxLargestTraderShare) {
          addLog(`GOD Reject: ${token.symbol} early flow is too concentrated in one wallet (${(largestTraderVolumeShare * 100).toFixed(0)}%).`);
          return;
        }

        if (topTwoTraderVolumeShare > godMaxTopTwoTraderShare && uniqueTraderCount < 12) {
          addLog(`GOD Reject: ${token.symbol} top 2 wallets dominate the early tape (${(topTwoTraderVolumeShare * 100).toFixed(0)}%).`);
          return;
        }

        if (creatorVolumeShare > (config.isDemo ? 0.3 : 0.24) && age >= 15) {
          addLog(`GOD Reject: ${token.symbol} creator-linked flow is too dominant (${(creatorVolumeShare * 100).toFixed(0)}% of observed volume).`);
          return;
        }

        const participationReady = reclaimLaneActive
          ? (
            buyCount >= (config.isDemo ? 6 : 7) &&
            tradeCount >= (config.isDemo ? 8 : 8) &&
            uniqueTraderCount >= (config.isDemo ? 6 : 6) &&
            observedVolume >= (config.isDemo ? 1.2 : 1.25) &&
            buyPressure >= (config.isDemo ? 0.56 : 0.58) &&
            buyPressure <= (config.isDemo ? 0.9 : 0.92) &&
            netFlow >= (config.isDemo ? 0.28 : 0.28) &&
            traderDiversity >= (config.isDemo ? 0.42 : 0.42)
          )
          : (
            buyCount >= (config.isDemo ? 5 : 6) &&
            tradeCount >= (config.isDemo ? 7 : 9) &&
            uniqueTraderCount >= (config.isDemo ? 5 : 6) &&
            observedVolume >= (config.isDemo ? 1.0 : 1.25) &&
            buyPressure >= (config.isDemo ? 0.58 : 0.6) &&
            netFlow >= (config.isDemo ? 0.32 : 0.45) &&
            traderDiversity >= (config.isDemo ? 0.4 : 0.44)
          );
        const curveReady = reclaimLaneActive
          ? (
            bondingCurveProgress >= (config.isDemo ? 4 : 5) &&
            bondingCurveProgress <= (config.isDemo ? 18 : 16) &&
            curveVelocity >= (config.isDemo ? 0.45 : 0.55) &&
            curveVelocity <= (config.isDemo ? 10 : 10) &&
            momentum >= (config.isDemo ? 0.55 : 0.65) &&
            priceChangePercent <= (config.isDemo ? 30 : 28) &&
            priceChangePercent > -1.25
          )
          : (
            bondingCurveProgress >= (config.isDemo ? 1.0 : 1.5) &&
            bondingCurveProgress <= (config.isDemo ? 15 : 14) &&
            curveVelocity >= (config.isDemo ? 0.55 : 0.7) &&
            momentum >= (config.isDemo ? 0.75 : 0.9) &&
            priceChangePercent > -0.75
          );
        const executionReady = reclaimLaneActive
          ? (
            capitalEfficiency >= (config.isDemo ? 0.075 : 0.085) &&
            stressImpactPercent <= (config.isDemo ? 2.2 : 1.8) &&
            sellCount <= Math.max(2, Math.floor(tradeCount * 0.48))
          )
          : (
            capitalEfficiency >= (config.isDemo ? 0.08 : 0.09) &&
            stressImpactPercent <= (config.isDemo ? 2.2 : 1.7) &&
            sellCount <= Math.max(2, Math.floor(tradeCount * 0.42))
          );

        const needsShakeoutConfirmation =
          age >= 18 &&
          observedVolume >= (config.isDemo ? 1.0 : 1.25) &&
          tradeCount >= (config.isDemo ? 5 : 7) &&
          sellCount < 1;

        if (needsShakeoutConfirmation) {
          if (age < 55) {
            scheduleRetry(5000, `GOD wait: ${token.symbol} still needs a small shakeout and absorb before entry.`);
          } else {
            addLog(`GOD Reject: ${token.symbol} never showed a clean absorb after the first impulse.`);
          }
          return;
        }

        if (age >= 20 && buyPressure > 0.92 && sellCount === 0 && uniqueTraderCount < (config.isDemo ? 8 : 9)) {
          if (age < 60) {
            scheduleRetry(5000, `GOD wait: ${token.symbol} order flow is still too one-sided to trust (${(buyPressure * 100).toFixed(0)}% buys, no sells yet).`);
          } else {
            addLog(`GOD Reject: ${token.symbol} stayed too one-sided and looks coordinated.`);
          }
          return;
        }

        if ((!participationReady || !curveReady || !executionReady) && (age < 105 || waitingOnSnapshot)) {
          scheduleRetry(
            5000,
            `GOD wait: ${token.symbol} needs cleaner runner confirmation (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, eff ${capitalEfficiency.toFixed(3)}, impact ${stressImpactPercent.toFixed(2)}%).`
          );
          return;
        }

        if (!participationReady || !curveReady || !executionReady) {
          addLog(`GOD Reject: ${token.symbol} failed the runner gate (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, eff ${capitalEfficiency.toFixed(3)}, impact ${stressImpactPercent.toFixed(2)}%).`);
          return;
        }

        const godAnalysisConfig = {
          ...config.advanced,
          minLiquidity: Math.max(config.advanced?.minLiquidity ?? 0, config.isDemo ? 32 : 36),
          maxLiquidity: Math.min(config.advanced?.maxLiquidity ?? 9999, config.isDemo ? (reclaimLaneActive ? 170 : 150) : (reclaimLaneActive ? 130 : 125)),
          minVolume: Math.max(config.advanced?.minVolume ?? 0, config.isDemo ? 1.0 : 1.25),
          minHolderCount: Math.max(config.advanced?.minHolderCount ?? 0, config.isDemo ? 12 : 12),
          maxTop10: Math.min(config.advanced?.maxTop10 ?? 100, config.isDemo ? 28 : 22),
          maxDev: Math.min(config.advanced?.maxDev ?? 100, 3),
          minBondingCurve: Math.max(config.advanced?.minBondingCurve ?? 0, config.isDemo ? 1.0 : 1.5),
          maxBondingCurve: Math.min(config.advanced?.maxBondingCurve ?? 100, config.isDemo ? (reclaimLaneActive ? 18 : 15) : (reclaimLaneActive ? 16 : 14)),
          minVelocity: Math.max(config.advanced?.minVelocity ?? 0, config.isDemo ? (reclaimLaneActive ? 0.45 : 0.6) : (reclaimLaneActive ? 0.55 : 0.7)),
          rugCheckStrictness: 'strict',
          requireSocials: false,
          avoidSnipers: true,
          slippage: Math.min(config.advanced?.slippage || 12, config.isDemo ? 16 : 12)
        };
        const analysis = await analyzeEnhanced(token, connection, config.heliusKey, 'god', godAnalysisConfig);

        if (!analysis.passed) {
          if (age < 110) {
            scheduleRetry(7000, `GOD wait: ${token.symbol} still lacks safe runner structure (${analysis.reasons[0] || 'analysis pending'}).`);
          } else {
            addLog(`GOD Reject: ${token.symbol} - ${analysis.reasons.join(', ') || 'analysis rejected trade'}`);
          }
          return;
        }

        const creatorHoldings = analysis.metrics.deployerHoldings;
        const top10Concentration = analysis.metrics.top10Concentration;
        const godScore = calculateGodModeScore({
          age,
          observedVolume,
          tradeCount,
          uniqueTraderCount,
          buyPressure,
          bondingCurveProgress,
          netFlow,
          priceChangePercent,
          stressImpactPercent,
          top10Concentration,
          creatorHoldings,
          largestTraderVolumeShare,
          topTwoTraderVolumeShare,
          creatorSellCount
        });
        const godScoreFloor = config.isDemo ? (reclaimLaneActive ? 70 : 72) : (reclaimLaneActive ? 76 : 78);

        if (godScore < godScoreFloor) {
          if (age < 95) {
            scheduleRetry(6000, `GOD wait: ${token.symbol} composite score ${godScore}/100 is not there yet.`);
          } else {
            addLog(`GOD Reject: ${token.symbol} composite score ${godScore}/100 is below the runner floor.`);
          }
          return;
        }

        addLog(`GOD setup: ${token.symbol} - score ${godScore}/100 | flow ${tradeCount} trades | ${(buyPressure * 100).toFixed(0)}% buy pressure | top1 ${(largestTraderVolumeShare * 100).toFixed(0)}% | top10 ${top10Concentration.toFixed(1)}% | creator ${creatorHoldings >= 0 ? `${creatorHoldings.toFixed(1)}%` : 'N/A'} | impact ${stressImpactPercent.toFixed(2)}%`);

        const setupPrice = token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0
          ? calculatePumpPrice(token.vSolInBondingCurve, token.vTokensInBondingCurve)
          : 0;
        await new Promise(r => setTimeout(r, config.isDemo ? 800 : 1200));
        const freshData = await getPumpData(token.mint, connection);
        const freshSnapshot = getMarketSnapshot(token.mint);
        const verifiedLiquidity = freshData?.vSolInBondingCurve || liquidity;
        const verifiedTokens = freshData?.vTokensInBondingCurve || token.vTokensInBondingCurve;
        const verifiedCurveProgress = Number.isFinite(freshData?.bondingCurveProgress) ? freshData!.bondingCurveProgress : bondingCurveProgress;
        const verifiedPrice = verifiedLiquidity > 0 && verifiedTokens > 0
          ? calculatePumpPrice(verifiedLiquidity, verifiedTokens)
          : setupPrice;
        const liquidityDeltaPercent = liquidity > 0 ? ((verifiedLiquidity - liquidity) / liquidity) * 100 : 0;
        const curveDelta = verifiedCurveProgress - bondingCurveProgress;
        const priceDeltaPercent = setupPrice > 0 && verifiedPrice > 0 ? ((verifiedPrice - setupPrice) / setupPrice) * 100 : 0;
        const freshBuyPressure = freshSnapshot?.buyPressure ?? buyPressure;
        const freshUniqueTraders = freshSnapshot?.uniqueTraderCount ?? uniqueTraderCount;
        const freshLargestTraderShare = freshSnapshot?.largestTraderVolumeShare ?? largestTraderVolumeShare;
        const freshCreatorSellCount = freshSnapshot?.creatorSellCount ?? creatorSellCount;

        const verificationBuyPressureFloor = reclaimLaneActive ? (config.isDemo ? 0.54 : 0.56) : 0.57;
        if (
          liquidityDeltaPercent < (reclaimLaneActive ? -4.8 : -4) ||
          curveDelta < (reclaimLaneActive ? -1.1 : -0.8) ||
          priceDeltaPercent < (reclaimLaneActive ? -2.4 : -1.8) ||
          freshBuyPressure < verificationBuyPressureFloor
        ) {
          addLog(`GOD Reject: ${token.symbol} lost too much confirmation (${liquidityDeltaPercent.toFixed(1)}% liquidity, ${curveDelta.toFixed(1)} curve pts, ${priceDeltaPercent.toFixed(1)}% price, ${(freshBuyPressure * 100).toFixed(0)}% buy pressure).`);
          return;
        }

        if (freshLargestTraderShare > (config.isDemo ? 0.34 : 0.3) || freshCreatorSellCount > 0) {
          addLog(`GOD Reject: ${token.symbol} confirmation stayed too concentrated or creator-led (top1 ${(freshLargestTraderShare * 100).toFixed(0)}%, creator sells ${freshCreatorSellCount}).`);
          return;
        }

        if (verifiedLiquidity <= 0 || freshUniqueTraders < uniqueTraderCount) {
          scheduleRetry(6000, `GOD wait: ${token.symbol} verification snapshot is still settling.`);
          return;
        }

        token.vSolInBondingCurve = verifiedLiquidity;
        token.vTokensInBondingCurve = verifiedTokens;

        const initialPrice = token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0
          ? calculatePumpPrice(token.vSolInBondingCurve, token.vTokensInBondingCurve)
          : undefined;
        const godAmount = Number((config.amount * (godScore >= 86 ? 1 : 0.85)).toFixed(4));
        const starterAmount = Number((godAmount * 0.65).toFixed(4));
        const scaleInAmount = Number(Math.max(0, godAmount - starterAmount).toFixed(4));
        const exitStrategy = {
          takeProfit: 24,
          takeProfit2: 55,
          stopLoss: config.isDemo ? 5 : 4.5,
          maxHoldTime: 180,
          trailingStop: false,
          momentumExit: false,
          minHoldTime: 10,
          fastKillLoss: config.isDemo ? 3.2 : 2.5,
          fastKillSeconds: 6,
          givebackPeakTrigger: 6,
          givebackFloor: 1.5,
          givebackSeconds: 15,
          stagnationSeconds: 35,
          stagnationFloor: 2,
          tp1SellPercent: 75,
          tp2SellPercent: 15,
          postTp1FloorPercent: 4,
          postTp2FloorPercent: 10,
          runnerMaxHoldTime: 420,
          runnerTrailingStopPercent: 14,
          runnerActivationProfit: 25,
          runnerTimeExitFloor: 6
        };
        const scaleInPlan = scaleInAmount >= 0.001 ? {
          pendingSol: scaleInAmount,
          triggerPnlPercent: 8,
          requiredObservedVolumeSol: Number((observedVolume + (config.isDemo ? 0.7 : 1.2)).toFixed(3)),
          requiredUniqueTraderCount: uniqueTraderCount + 2,
          requiredBuyPressure: Number(Math.max(0.62, buyPressure).toFixed(2)),
          maxWaitSeconds: config.isDemo ? 60 : 45,
          inFlight: false,
          completed: false,
          expired: false
        } : undefined;
        const godSlippage = Math.min(config.advanced?.slippage || 14, config.isDemo ? 18 : 14);

        setLastTradeTime(Date.now());
        if (scaleInPlan) {
          addLog(`GOD staged entry: ${token.symbol} starter ${starterAmount.toFixed(4)} SOL, add-on ${scaleInAmount.toFixed(4)} SOL only if the runner confirms.`);
        }
        await buyToken(token.mint, token.symbol, scaleInPlan ? starterAmount : godAmount, godSlippage, initialPrice, exitStrategy, scaleInPlan ? { scaleInPlan } : undefined);
        return;
      } catch (error: any) {
        addLog(`GOD error for ${token.symbol}: ${error.message}`);
        return;
      }
    }

    // === ENHANCED TOKEN ANALYSIS (Safe/Medium/High modes) - Based on Research ===
    try {
      // ENTRY CONFIRMATION: Wait for momentum confirmation before buying
      // This prevents buying into dead tokens
      const age = getTokenAgeSeconds(token);
      const liquidityGrowth = (token.vSolInBondingCurve || 30) - 30;
      const momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0;

      // 1. MOMENTUM HURDLE: If token is >30s old and has < 0.5 SOL growth, it's inactive.
      // This saves HUNDREDS of RPC calls by skipping "Dead Air" tokens.
      if (age > 30 && liquidityGrowth < 0.5 && config.mode !== 'high' && config.mode !== 'first') {
        return;
      }

      // 2. SNIPER TRAP CHECK: If token pumped too fast (>20 SOL in <30s), it's likely a bot trap
      if (age < 30 && liquidityGrowth > 20 && config.mode !== 'high' && config.mode !== 'first') {
        addLog(`🚨 Sniper Trap Avoided: ${token.symbol} pumped +${liquidityGrowth.toFixed(2)} SOL in ${age.toFixed(1)}s. Too risky.`);
        return;
      }

      // 2. DEAD TOKEN CHECK: If token is old (>2m) with no momentum, skip
      if (age > 120 && momentum < 0.1 && config.mode !== 'high') {
        addLog(`💤 Dead Token: ${token.symbol} is ${Math.floor(age / 60)}m old with 0 momentum. Skipping.`);
        return;
      }

      if (config.mode === 'sniper') {
        const sniperConfirmation = evaluateLiveSniperConfirmation(token, age);
        if (sniperConfirmation.decision === 'wait') {
          scheduleRetry(
            sniperConfirmation.waitTimeMs || 6000,
            `⏳ ${token.symbol} sniper confirmation: ${sniperConfirmation.reason}`
          );
          return;
        }

        if (sniperConfirmation.decision === 'reject') {
          addLog(`🚫 Sniper Reject: ${token.symbol} - ${sniperConfirmation.reason}`);
          processedMints.current.add(token.mint);
          return;
        }
      }

      const shouldQueueYoungTokenRetry =
        age < 30 &&
        config.mode !== 'high' &&
        config.mode !== 'first' &&
        config.mode !== 'scalp' &&
        liquidityGrowth < 0.1 &&
        momentum < 1.5;

      if (shouldQueueYoungTokenRetry) {
        scheduleRetry(15000, `â³ ${token.symbol} too new (${age.toFixed(1)}s). Monitoring for activity...`);
        return;
      }

      if (age < 30 && config.mode !== 'high' && config.mode !== 'first' && config.mode !== 'scalp') {
        if (liquidityGrowth < 0.1 && momentum < 1.5) {
          if (!pendingRetries.current.has(token.mint)) {
            pendingRetries.current.add(token.mint);
            addLog(`⏳ ${token.symbol} too new (${age.toFixed(1)}s). Monitoring for activity...`);
            setTimeout(() => onTokenDetected(getLatestToken(token.mint) || token, true), 15000);
          }
          return;
        } else if (momentum >= 1.5) {
          addLog(`🚀 High Momentum detected for ${token.symbol} (${momentum.toFixed(1)} SOL/min)! Bypassing wait...`);
        }
      }

      // Full enhanced analysis
      // NOTE: Demo mode uses REAL tokens, not simulated ones
      // Only skip analysis for SIM tokens in simulation mode (not demo mode)
      let analysis: EnhancedAnalysis;
      if (token.mint.startsWith('SIM') && !config.isDemo) {
        // For simulated tokens, create a simplified analysis
        const devBuy = (token.vSolInBondingCurve || 30) - 30;
        const isRug = devBuy < 0.5 || token.name === "Garbage Coin";
        analysis = {
          score: isRug ? 20 : 75,
          riskLevel: isRug ? 'high' : 'low' as const,
          passed: !isRug && devBuy >= 1.0,
          reasons: isRug ? ['Simulated rug token'] : [],
          warnings: devBuy < 1.0 ? ['Low dev buy'] : [],
          strengths: devBuy >= 2.0 ? ['High dev commitment'] : [],
          bondingCurveProgress: 5,
          marketCap: token.vSolInBondingCurve || 30,
          tiers: {
            tier0: isRug ? 20 : 80,
            tier1: 0,
            tier2: 0,
            tier3: 0,
            tier4: 0,
            totalScore: (isRug ? 20 : 75) * 5
          },
          metrics: {
            holderCount: 100,
            deployerHoldings: 10,
            top10Concentration: 40,
            observedVolume: 5,
            buyPressure: 0.7,
            bondingCurveVelocity: 0.5,
            liquidityDepth: token.vSolInBondingCurve || 30,
            tradeCount: 0,
            uniqueTraderCount: 0,
            priceChangePercent: 0,
            largestTraderVolumeShare: 0,
            topTwoTraderVolumeShare: 0,
            creatorVolumeShare: 0,
            creatorBuyCount: 0,
            creatorSellCount: 0,
            contractSecurity: { freezeAuthority: true, mintAuthority: true, updateAuthority: true }
          }
        };
      } else {
        // Enhanced analysis for real tokens (based on research)
        // Pass risk mode to analyzer so it can adjust strictness
        // Mapping: Maps new modes (runner, sniper, degen) to analyzer logic
        const riskModeMap: Record<string, 'runner' | 'sniper' | 'degen' | 'god' | 'safe' | 'medium' | 'high' | 'velocity'> = {
          'runner': 'runner',
          'safe': 'runner',
          'medium': 'runner',
          'god': 'god',
          'sniper': 'sniper',
          'first': 'sniper',
          'degen': 'degen',
          'micro': 'velocity',
          'high': 'degen',
          'velocity': 'degen',
          'scalp': 'degen',
          'custom': 'medium'
        };
        const riskMode = riskModeMap[config.mode] || 'medium';
        const analysisConfig = config.advanced;
        // @ts-ignore
        analysis = await analyzeEnhanced(token, connection, config.heliusKey, riskMode as any, analysisConfig);

      }

      // Mode-based filtering with analysis scores
      // IMPORTANT: High-risk mode should still have MINIMUM quality standards
      // Mode-based filtering with analysis scores
      // IMPORTANT: Velocity mode score requirement is handled inside analyzeEnhanced (passed = 40)
      // but we still define the display minScore here
      let minScore = 30;
      if (config.mode === 'runner' || config.mode === 'safe') minScore = 70;
      else if (config.mode === 'medium' || config.mode === 'custom') minScore = 50;
      else if (config.mode === 'god') minScore = 75;
      else if (config.mode === 'sniper' || config.mode === 'first') minScore = 60; // Tier 0 must pass
      else if (config.mode === 'degen' || config.mode === 'velocity' || config.mode === 'high') minScore = 35;
      else if (config.mode === 'micro') minScore = 45;
      if (config.mode === 'degen') minScore = Math.max(minScore, config.isDemo ? 38 : 42);

      // For high-risk mode with strong momentum, we can be slightly more lenient
      // But still maintain minimum quality.
      if (config.mode === 'high' && age < 120 && momentum > 2) {
        minScore = 20;
      }

      if (config.mode === 'sniper' && analysis.score < 25) {
        addLog(`🚫 Sniper Reject: ${token.symbol} - Live sniper score floor not met (${analysis.score}/100 < 25).`);
        return;
      }

      if (config.mode === 'degen') {
        const snapshot = getMarketSnapshot(token.mint);
        const tradeCount = snapshot?.tradeCount || analysis.metrics.tradeCount || 0;
        const buyCount = snapshot?.buyCount || 0;
        const sellCount = snapshot?.sellCount || 0;
        const uniqueTraderCount = snapshot?.uniqueTraderCount || analysis.metrics.uniqueTraderCount || 0;
        const observedVolume = snapshot?.observedVolumeSol || analysis.metrics.observedVolume || 0;
        const buyPressure = snapshot?.buyPressure ?? analysis.metrics.buyPressure ?? 0;
        const strongFlowConfirmation =
          buyCount >= 4 &&
          tradeCount >= 6 &&
          uniqueTraderCount >= 4 &&
          observedVolume >= 1.4 &&
          buyPressure >= 0.64;
        const steadyTapeConfirmation =
          tradeCount >= 20 &&
          uniqueTraderCount >= 6 &&
          observedVolume >= 1.8 &&
          buyPressure >= 0.61;
        const feedMomentumConfirmation =
          age <= 45 &&
          tradeCount >= 2 &&
          uniqueTraderCount >= 2 &&
          liquidityGrowth >= 1.0 &&
          momentum >= 1.55 &&
          buyPressure >= 0.55;
        const curveReady =
          (analysis.bondingCurveProgress >= 3 && analysis.bondingCurveProgress <= 16) ||
          (analysis.bondingCurveProgress >= 1.75 && liquidityGrowth >= 0.8);
        const deepLiquidityConfirmation =
          analysis.marketCap >= 55 &&
          observedVolume >= 1.5 &&
          uniqueTraderCount >= 4 &&
          (analysis.bondingCurveProgress >= 2 || liquidityGrowth >= 1.0);
        const waitingOnSnapshot =
          age <= 45 &&
          tradeCount === 0 &&
          uniqueTraderCount <= 1 &&
          observedVolume <= 0.2 &&
          liquidityGrowth > 0.25;

        if (waitingOnSnapshot && (feedMomentumConfirmation || analysis.marketCap >= 35)) {
          scheduleRetry(5000, `⏳ Degen wait: ${token.symbol} early flow snapshot still syncing (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, curve ${analysis.bondingCurveProgress.toFixed(1)}%).`);
          return;
        }

        if (sellCount > Math.max(2, Math.floor(tradeCount * 0.4)) && age <= 90) {
          addLog(`🚫 Degen Reject: ${token.symbol} already shows too much sell pressure (${sellCount}/${tradeCount} sells).`);
          return;
        }

        if (tradeCount >= 4 && buyPressure < 0.55) {
          addLog(`🚫 Degen Reject: ${token.symbol} buy pressure is too weak for aggressive mode (${(buyPressure * 100).toFixed(0)}%).`);
          return;
        }

        if (!curveReady && !strongFlowConfirmation && !steadyTapeConfirmation && !deepLiquidityConfirmation && !feedMomentumConfirmation) {
          if (age < 75) {
            scheduleRetry(6000, `⏳ Degen wait: ${token.symbol} needs more early flow (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, curve ${analysis.bondingCurveProgress.toFixed(1)}%).`);
            return;
          }
          addLog(`ðŸš« Degen Reject: ${token.symbol} - Early flow too weak (${tradeCount} trades, ${(buyPressure * 100).toFixed(0)}% buy pressure, curve ${analysis.bondingCurveProgress.toFixed(1)}%).`);
          return;
        }
      }

      // If RPC is failing (analysis might be incomplete), be very lenient
      // Check if analysis has warnings about RPC issues
      const hasRpcIssues = analysis.warnings.some(w => w.includes('RPC') || w.includes('Access denied') || w.includes('rate limit') || w.includes('basic analysis'));
      if (false && config.isDemo && hasRpcIssues) {
        // If RPC is failing, accept tokens with lower scores (analysis is incomplete)
        minScore = Math.max(10, minScore - 20); // Lower by 20 points, minimum 10
        addLog(`⚠️ RPC issues detected - lowering score threshold to ${minScore} for ${token.symbol}`);
      }

      // The analyzer already decides pass/fail per strategy. Keep the score gate
      // for weak/fallback analyses, but don't block a token that the live
      // strategy-specific analyzer has explicitly approved.
      if (analysis.score < minScore && !analysis.passed) {
        addLog(`🚫 Rejected: ${token.symbol} - Score: ${analysis.score}/100 (Need: ${minScore}) - ${analysis.riskLevel.toUpperCase()} risk`);
        addLog(`   Bonding Curve: ${analysis.bondingCurveProgress.toFixed(1)}% | Market Cap: ${analysis.marketCap.toFixed(1)} SOL`);
        if (analysis.reasons.length > 0) {
          analysis.reasons.forEach(r => addLog(`   ${r}`));
        }
        if (analysis.warnings.length > 0) {
          analysis.warnings.forEach(w => addLog(`   ⚠️ ${w}`));
        }
        return;
      }

      const shouldRetryEarlyAnalysis =
        !analysis.passed &&
        analysis.reasons.some(r => r.includes('Too early')) &&
        age < 60;

      if (shouldRetryEarlyAnalysis) {
        const waitTime = isRetrying ? 20000 : 15000;
        scheduleRetry(waitTime, `â³ ${token.symbol} still early (${analysis.bondingCurveProgress.toFixed(1)}%). Re-checking in ${waitTime / 1000}s...`);
        return;
      }

      if (!analysis.passed) {
        // PERSISTENT MONITORING: If rejected for being 'too early', retry until it's at least 60s old
        if (analysis.reasons.some(r => r.includes('Too early')) && age < 60) {
          const waitTime = isRetrying ? 20000 : 15000;
          addLog(`⏳ ${token.symbol} still early (${analysis.bondingCurveProgress.toFixed(1)}%). Re-checking in ${waitTime / 1000}s...`);
          setTimeout(() => onTokenDetected(getLatestToken(token.mint) || token, true), waitTime);
          return;
        }

        if (isRetrying) {
          addLog(`🚫 Retry Rejected: ${token.symbol} - ${analysis.reasons.join(', ')}`);
        } else {
          addLog(`🚫 Rejected: ${token.symbol} - ${analysis.reasons.join(', ')}`);
        }
        return;
      }

      const guardEligibleModes = new Set(['runner', 'safe', 'medium', 'sniper', 'first', 'degen', 'high', 'velocity', 'scalp']);
      if (guardEligibleModes.has(config.mode)) {
        const guardDecision = evaluateLiveEntryGuard(config.mode as any, token, analysis, config.amount);
        if (guardDecision.status === 'wait') {
          scheduleRetry(5000, `⏳ ${token.symbol} guard: ${guardDecision.reason || 'waiting for cleaner confirmation'}`);
          return;
        }
        if (guardDecision.status === 'reject') {
          addLog(`🚫 Guard Reject: ${token.symbol} - ${guardDecision.reason || 'live entry guard failed'}`);
          return;
        }
      }

      // Log enhanced analysis results
      addLog(`✅ APPROVED: ${token.symbol} - Score: ${analysis.score}/100 (${analysis.riskLevel} risk)`);
      addLog(`   📊 Bonding Curve: ${analysis.bondingCurveProgress.toFixed(1)}% | Market Cap: ${analysis.marketCap.toFixed(1)} SOL`);
      const deployerHoldingsText = analysis.metrics.deployerHoldings >= 0
        ? `${analysis.metrics.deployerHoldings.toFixed(1)}%`
        : 'N/A';
      addLog(`   👥 Holders: ${analysis.metrics.holderCount} | Deployer: ${deployerHoldingsText} | Top 10: ${analysis.metrics.top10Concentration.toFixed(1)}%`);
      addLog(`   💰 Observed Vol: ${analysis.metrics.observedVolume.toFixed(1)} SOL | Buy Pressure: ${(analysis.metrics.buyPressure * 100).toFixed(0)}% | Trades: ${analysis.metrics.tradeCount}`);
      addLog(`   ⚡ Velocity: ${analysis.metrics.bondingCurveVelocity.toFixed(2)}%/min | Liquidity: ${analysis.metrics.liquidityDepth.toFixed(1)} SOL | Price Δ: ${analysis.metrics.priceChangePercent.toFixed(1)}%`);

      if (analysis.strengths.length > 0) {
        analysis.strengths.forEach(s => addLog(`   ✓ ${s}`));
      }
      if (analysis.warnings.length > 0) {
        analysis.warnings.forEach(w => addLog(`   ⚠️ ${w}`));
      }

      // DYNAMIC POSITION SIZING: Adjust based on analysis score and confidence
      // Higher score = larger position (up to 2x base amount)
      // Lower score = smaller position (down to 0.5x base amount)
      let positionSize = config.amount;
      const liveDegenMinMultiplier = !config.isDemo && (config.mode === 'degen' || config.mode === 'micro') ? 0.75 : 0.5;
      if (config.dynamicSizing) {
        const scoreMultiplier = Math.max(liveDegenMinMultiplier, Math.min(2.0, (analysis.score / 50)));
        positionSize = config.amount * scoreMultiplier;

        if (Math.abs(positionSize - config.amount) > 0.001) {
          addLog(`💰 Dynamic Sizing: ${positionSize.toFixed(4)} SOL (${scoreMultiplier > 1 ? '+' : ''}${((scoreMultiplier - 1) * 100).toFixed(0)}% based on score ${analysis.score})`);
        }
      } else {
        addLog(`💰 Fixed Position: ${positionSize.toFixed(4)} SOL (Dynamic Sizing OFF)`);
      }

      // Portfolio heat management: Reduce position size if too many trades open
      const openTradesCount = activeTrades.filter(t => t.status === "open").length;
      if (openTradesCount >= 3) {
        positionSize *= 0.7; // Reduce by 30% if 3+ trades open
      } else if (openTradesCount >= 2) {
        positionSize *= 0.85; // Reduce by 15% if 2 trades open
      }

      // Cap position size for safety
      const maxPositionMultiplier = config.mode === 'degen' ? 1.25 : 2;
      positionSize = Math.min(positionSize, config.amount * maxPositionMultiplier);
      positionSize = Math.max(positionSize, config.amount * (!config.isDemo && (config.mode === 'degen' || config.mode === 'micro') ? 0.75 : 0.3));

      console.log("[onTokenDetected] ✅ Executing buy for:", token.symbol, "Amount:", positionSize.toFixed(4), "SOL", "Score:", analysis.score, "Curve:", analysis.bondingCurveProgress.toFixed(1) + "%");
      const initialPrice = token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0
        ? calculatePumpPrice(token.vSolInBondingCurve, token.vTokensInBondingCurve)
        : undefined;

      setLastTradeTime(Date.now());
      // Use user-defined slippage if available, otherwise fall back to adaptive
      const slippage = config.advanced?.slippage || ((config.mode === 'high' || config.mode === 'scalp' || config.mode === 'first' || config.mode === 'sniper') ? 25 : 15);

      // Finalize: Token successfully passed all filters
      processedMints.current.add(token.mint);

      const isAggressiveAlias = config.mode === 'degen' || config.mode === 'high' || config.mode === 'velocity' || config.mode === 'scalp';
      const isExperimentalAlias = config.mode === 'sniper' || config.mode === 'first';
      const exitStrategy = isAggressiveAlias
        ? {
            takeProfit: Math.min(config.takeProfit, 8),
            takeProfit2: 14,
            stopLoss: Math.min(config.stopLoss, 4),
            maxHoldTime: 40,
            trailingStop: false,
            momentumExit: false,
            minHoldTime: 6,
            fastKillLoss: 2.2,
            fastKillSeconds: 5,
            givebackPeakTrigger: 3.2,
            givebackFloor: 0.2,
            givebackSeconds: 6,
            stagnationSeconds: 10,
            stagnationFloor: -0.5,
            tp1SellPercent: 82,
            tp2SellPercent: 8,
            postTp1FloorPercent: 1,
            postTp2FloorPercent: 3,
            runnerMaxHoldTime: 90,
            runnerTrailingStopPercent: 6,
            runnerActivationProfit: 8,
            runnerTimeExitFloor: 2
          }
        : isExperimentalAlias
        ? {
            takeProfit: Math.min(config.takeProfit, 8),
            takeProfit2: 14,
            stopLoss: Math.min(config.stopLoss, 4),
            maxHoldTime: 30,
            trailingStop: false,
            momentumExit: false,
            minHoldTime: 5,
            fastKillLoss: 2.2,
            fastKillSeconds: 4,
            givebackPeakTrigger: 3.2,
            givebackFloor: 0.4,
            givebackSeconds: 7,
            stagnationSeconds: 12,
            stagnationFloor: -0.5,
            tp1SellPercent: 85,
            tp2SellPercent: 10,
            postTp1FloorPercent: 1.2,
            postTp2FloorPercent: 4,
            runnerMaxHoldTime: 90,
            runnerTrailingStopPercent: 8,
            runnerActivationProfit: 8,
            runnerTimeExitFloor: 2
          }
        : {
            takeProfit: config.takeProfit,
            takeProfit2: config.mode === 'micro' ? 35 : undefined,
            stopLoss: config.stopLoss,
            maxHoldTime: config.mode === 'micro' ? 90 : 3600,
            trailingStop: config.mode === 'runner', // Enable trailing stop for runners
            momentumExit: false,
            minHoldTime: config.mode === 'micro' ? 12 : undefined,
          };

      await buyToken(token.mint, token.symbol, positionSize, slippage, initialPrice, exitStrategy);
    } catch (error: any) {
      addLog(`❌ Analysis Error for ${token.symbol}: ${error.message}`);
      console.error("Token analysis error:", error);
      // Fallback to old simple check for safety
      const initialBuySol = (token.vSolInBondingCurve || 30) - 30;
      if (config.mode === 'safe' && initialBuySol < 2.0) {
        addLog(`Fallback: Skipping ${token.symbol} - Dev Buy too low`);
        return;
      }
      // Never auto-buy live capital on analyzer failure.
      // Keep the fallback path only for custom paper testing.
      const allowFallbackBuy = config.mode === 'custom' && config.isDemo;
      if (allowFallbackBuy) {
        // Calculate initial price from token data
        // Demo mode uses REAL tokens, so always calculate from real token data
        let initialPrice: number | undefined;
        if (token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0) {
          initialPrice = calculatePumpPrice(token.vSolInBondingCurve, token.vTokensInBondingCurve);
        } else {
          // Price will be fetched from blockchain in buyToken if not available here
          initialPrice = undefined;
        }
        setLastTradeTime(Date.now());
        const dynamicSlippage = (config.mode === 'high' || config.mode === 'scalp' || config.mode === 'first' || config.mode === 'sniper') ? 25 : 15;

        const exitStrategy = {
          takeProfit: config.takeProfit,
          stopLoss: config.stopLoss,
          maxHoldTime: config.mode === 'sniper' ? 300 : (config.mode === 'degen' ? 120 : 3600),
          trailingStop: config.mode === 'runner',
          momentumExit: config.mode === 'degen',
        };

        await buyToken(token.mint, token.symbol, config.amount, dynamicSlippage, initialPrice, exitStrategy);
      } else {
        addLog(`🚫 Fallback blocked: ${token.symbol} analysis failed, so no trade was placed.`);
      }
    }
    } catch (outerError: any) {
      addLog(`❌ Processing Error for ${token.symbol}: ${outerError.message}`);
    } finally {
      analyzingMints.current.delete(token.mint);
    }
  }, [config.isRunning, config.isDemo, config.mode, config.amount, config.heliusKey, wallet, activeTrades, tradeHistory, buyToken, realBalance, connection, addLog]);

  // Automated Sell Logic (TP/SL + Speed Trading)
  useEffect(() => {
    if (!config.isRunning) return;

    activeTrades.forEach(trade => {
      // Only process OPEN trades
      if (trade.status !== "open") return;

      // CRITICAL FIX: Don't skip if buyPrice is 0 - wait for it to be set
      // The price polling will set buyPrice on first update
      // Only skip if we have a currentPrice but no buyPrice after reasonable time
      if (!trade.buyPrice || trade.buyPrice === 0) {
        // If trade is older than 5 seconds and still no buyPrice, try to use currentPrice
        if (trade.buyTime && (Date.now() - trade.buyTime) > 5000) {
          if (trade.currentPrice && trade.currentPrice > 0) {
            // Use currentPrice as buyPrice if we've been waiting too long
            updateTrade(trade.mint, { buyPrice: trade.currentPrice });
            addLog(`[${trade.symbol}] Using currentPrice as buyPrice (${formatTokenPrice(trade.currentPrice)})`);
          } else {
            // Still no price after 5 seconds, skip this cycle
            return;
          }
        } else {
          // Trade is new, wait for price update
          return;
        }
      }

      // Use custom exit strategy if available (speed trading), otherwise use config
      const exitStrategy = trade.exitStrategy || {
        takeProfit: config.takeProfit,
        stopLoss: config.stopLoss,
        maxHoldTime: Infinity,
        trailingStop: false,
        minHoldTime: 0,
        momentumExit: false,
        takeProfit2: undefined,
        trailingStopPercent: undefined,
        fastKillLoss: undefined,
        fastKillSeconds: undefined,
        givebackPeakTrigger: undefined,
        givebackFloor: undefined,
        givebackSeconds: undefined,
        stagnationSeconds: undefined,
        stagnationFloor: undefined
      };

      const holdTimeSeconds = trade.buyTime ? (Date.now() - trade.buyTime) / 1000 : 0;
      const paperTradeWarmupSeconds = getPaperExitWarmupSeconds(trade);
      const paperTradeWarmupActive = (config.isDemo || trade.isPaper) && holdTimeSeconds < paperTradeWarmupSeconds;
      if (paperTradeWarmupActive) {
        return;
      }

      const liveExitWarmupSeconds = getLiveExitWarmupSeconds(config.mode);
      const liveTradeSettlementActive =
        !config.isDemo &&
        !trade.isPaper &&
        (((trade.amountTokens || 0) <= 0) || holdTimeSeconds < liveExitWarmupSeconds);
      if (liveTradeSettlementActive) {
        return;
      }

      const quarantine = getIdentityQuarantine(trade.symbol);
      if (!config.isDemo && !trade.isPaper && quarantine && holdTimeSeconds < 120) {
        addLog(`🚨 COPYCAT KILL SWITCH: ${trade.symbol} flagged after entry (${quarantine.reason}). Selling...`);
        sellToken(trade.mint, 100);
        return;
      }

      if (!trade.partialSells) {
        updateTrade(trade.mint, { partialSells: {} });
        return;
      }

      const currentPnl = trade.buyPrice > 0 && trade.currentPrice > 0
        ? ((trade.currentPrice - trade.buyPrice) / trade.buyPrice) * 100
        : trade.pnlPercent;
      const peakPnl = trade.highestPrice && trade.highestPrice > trade.buyPrice
        ? ((trade.highestPrice - trade.buyPrice) / trade.buyPrice) * 100
        : currentPnl;
      const runnerActive = hasTp1Sell(trade.partialSells);
      const runnerMaxHoldTime = getRunnerMaxHoldTime(exitStrategy, trade.partialSells);
      const profitLockFloor = getProfitLockFloor(exitStrategy, trade.partialSells);
      const scaleInPlan = trade.scaleInPlan;

      if (scaleInPlan && !scaleInPlan.completed && !scaleInPlan.expired && !scaleInPlan.inFlight) {
        const scaleSnapshot = getMarketSnapshot(trade.mint);
        const scaleObservedVolume = scaleSnapshot?.observedVolumeSol || 0;
        const scaleUniqueTraders = scaleSnapshot?.uniqueTraderCount || 0;
        const scaleBuyPressure = scaleSnapshot?.buyPressure ?? 0;
        const scaleTradeCount = scaleSnapshot?.tradeCount || 0;
        const scaleSellCount = scaleSnapshot?.sellCount || 0;
        const scaleTraderDiversity = calculateTraderDiversity(scaleUniqueTraders, scaleTradeCount);
        const scaleInConfirmed =
          currentPnl >= scaleInPlan.triggerPnlPercent &&
          scaleObservedVolume >= scaleInPlan.requiredObservedVolumeSol &&
          scaleUniqueTraders >= scaleInPlan.requiredUniqueTraderCount &&
          scaleBuyPressure >= scaleInPlan.requiredBuyPressure &&
          scaleTraderDiversity >= 0.45 &&
          scaleSellCount <= Math.max(2, Math.floor(scaleTradeCount * 0.4));

        if (holdTimeSeconds >= scaleInPlan.maxWaitSeconds) {
          updateTrade(trade.mint, {
            scaleInPlan: {
              ...scaleInPlan,
              pendingSol: 0,
              expired: true,
              inFlight: false
            }
          });
          addLog(`MICRO add-on expired: ${trade.symbol} never confirmed the runner leg in time.`);
        } else if (scaleInConfirmed && scaleInPlan.pendingSol > 0) {
          updateTrade(trade.mint, {
            scaleInPlan: {
              ...scaleInPlan,
              inFlight: true
            }
          });
          addLog(`MICRO add-on confirmed: ${trade.symbol} held ${currentPnl.toFixed(1)}% with ${scaleObservedVolume.toFixed(2)} SOL observed. Adding ${scaleInPlan.pendingSol.toFixed(4)} SOL.`);
          void buyToken(
            trade.mint,
            trade.symbol,
            scaleInPlan.pendingSol,
            !config.isDemo ? Math.min(config.advanced?.slippage || 18, 18) : Math.max(config.advanced?.slippage || 25, 30),
            trade.currentPrice > 0 ? trade.currentPrice : undefined,
            trade.exitStrategy,
            { allowTopUp: true }
          );
          return;
        }
      }

      if (trade.buyTime && runnerMaxHoldTime && holdTimeSeconds >= runnerMaxHoldTime) {
        const runnerTimeExitFloor = getRunnerTimeExitFloor(exitStrategy);
        if (currentPnl < runnerTimeExitFloor) {
          addLog(`⏳ RUNNER TIME EXIT: ${trade.symbol} stalled at ${currentPnl.toFixed(1)}% after ${Math.floor(holdTimeSeconds)}s. Selling remainder...`);
          sellToken(trade.mint, 100);
          return;
        }
      }

      // Time-based exit (for speed trading and first buyer)
      if (trade.buyTime && exitStrategy.maxHoldTime < Infinity && !runnerActive) {
        const holdTime = holdTimeSeconds; // seconds
        const minHoldTime = exitStrategy.minHoldTime || 0;

        // Check minimum hold time (for first buyer mode)
        if (holdTime < minHoldTime) {
          // Don't exit yet - still in minimum hold period
          return;
        }

        // Time-based exit after max hold time
        if (holdTime >= exitStrategy.maxHoldTime) {
          addLog(`⏰ TIME EXIT: ${trade.symbol} held for ${Math.floor(holdTime)}s (max: ${exitStrategy.maxHoldTime}s). Selling...`);
          sellToken(trade.mint, 100);
          return;
        }
      }

      const isFastCompoundTrade = !!exitStrategy.maxHoldTime && exitStrategy.maxHoldTime <= 90;
      const fastKillSeconds = exitStrategy.fastKillSeconds || 6;
      const fastKillLoss = Math.abs(exitStrategy.fastKillLoss || 4);
      const givebackSeconds = exitStrategy.givebackSeconds || 10;
      const givebackPeakTrigger = exitStrategy.givebackPeakTrigger || 4;
      const givebackFloor = exitStrategy.givebackFloor || 0;
      const stagnationSeconds = exitStrategy.stagnationSeconds || 0;
      const stagnationFloor = exitStrategy.stagnationFloor || 0;
      if (isFastCompoundTrade && !runnerActive && trade.buyPrice > 0 && trade.currentPrice > 0) {
        if (holdTimeSeconds >= fastKillSeconds && currentPnl <= -fastKillLoss) {
          addLog(`⚡ FAST KILL: ${trade.symbol} hit ${currentPnl.toFixed(1)}% inside the opening window. Exiting.`);
          sellToken(trade.mint, 100);
          return;
        }

        if (holdTimeSeconds >= givebackSeconds && peakPnl >= givebackPeakTrigger && currentPnl <= givebackFloor) {
          addLog(`⚡ FAST GIVEBACK EXIT: ${trade.symbol} faded from ${peakPnl.toFixed(1)}% to ${currentPnl.toFixed(1)}%. Exiting.`);
          sellToken(trade.mint, 100);
          return;
        }
      }

      if (isFastCompoundTrade && !runnerActive && trade.buyPrice > 0 && trade.currentPrice > 0 && stagnationSeconds > 0) {
        if (holdTimeSeconds >= stagnationSeconds && peakPnl < givebackPeakTrigger && currentPnl <= stagnationFloor) {
          addLog(`âš¡ FAST STALL EXIT: ${trade.symbol} failed to follow through (${currentPnl.toFixed(1)}% after ${holdTimeSeconds.toFixed(0)}s). Exiting.`);
          sellToken(trade.mint, 100);
          return;
        }
      }

      // Momentum-based exit (for first buyer mode)
      if (exitStrategy.momentumExit && trade.buyTime) {
        const holdTime = holdTimeSeconds;
        const minHoldTime = exitStrategy.minHoldTime || 0;

        // Only check momentum after minimum hold time
        if (holdTime >= minHoldTime && trade.pnlPercent > 5) {
          // If we're in profit and price is rising, consider early exit
          // This detects when others are buying (momentum)
          const recentPriceChange = trade.lastPriceChangeTime && (Date.now() - trade.lastPriceChangeTime) < 3000; // Price changed in last 3s
          if (recentPriceChange && trade.pnlPercent >= exitStrategy.takeProfit * 0.5) {
            // Exit early if we hit 50% of TP and momentum detected
            addLog(`📈 MOMENTUM EXIT: ${trade.symbol} - Others buying! Profit: ${trade.pnlPercent.toFixed(1)}%. Selling...`);
            sellToken(trade.mint, 100);
            return;
          }
        }
      }

      if (config.mode === 'high' && trade.buyTime) {
        const holdTime = holdTimeSeconds;
        if (holdTime < 10) {
          return;
        }
      }

      if (profitLockFloor !== null && currentPnl <= profitLockFloor) {
        addLog(`🛡️ PROFIT LOCK: ${trade.symbol} slipped to ${currentPnl.toFixed(1)}%. Lock floor was ${profitLockFloor.toFixed(1)}%. Exiting.`);
        sellToken(trade.mint, 100);
        return;
      }

      const runnerTrailingStopPercent = getRunnerTrailingStopPercent(exitStrategy, trade.partialSells);
      if (runnerTrailingStopPercent !== null && trade.highestPrice && trade.highestPrice > trade.buyPrice) {
        const currentDropFromPeak = ((trade.highestPrice - trade.currentPrice) / trade.highestPrice) * 100;
        const runnerActivationProfit = getRunnerActivationProfit(exitStrategy);
        if (peakPnl >= runnerActivationProfit && currentDropFromPeak >= runnerTrailingStopPercent) {
          addLog(`📉 RUNNER TRAIL: ${trade.symbol} gave back ${currentDropFromPeak.toFixed(1)}% from a ${peakPnl.toFixed(1)}% peak. Exiting moonbag.`);
          sellToken(trade.mint, 100);
          return;
        }
      }

      // Profit Protection: If we're in profit but price starts dropping, exit quickly
      // This prevents giving back profits on meme tokens
      if (!runnerActive && trade.buyPrice > 0 && trade.currentPrice > 0 && trade.highestPrice) {
        // If we were up 10%+ but now down to 5% or less, exit to protect profits
        if (peakPnl >= 10 && currentPnl <= 5 && currentPnl > 0) {
          addLog(`💰 PROFIT PROTECTION: ${trade.symbol} dropped from ${peakPnl.toFixed(1)}% to ${currentPnl.toFixed(1)}%. Securing profits...`);
          sellToken(trade.mint, 100);
          return;
        }

        // If we were up 20%+ but now down to 10% or less, exit immediately
        if (peakPnl >= 20 && currentPnl <= 10 && currentPnl > 0) {
          addLog(`💰 PROFIT PROTECTION: ${trade.symbol} dropped from ${peakPnl.toFixed(1)}% to ${currentPnl.toFixed(1)}%. Exiting...`);
          sellToken(trade.mint, 100);
          return;
        }
      }

      // ADAPTIVE TRAILING STOP: Tightens as profit increases
      // More profit = tighter stop to protect gains
      if (!runnerActive && trade.highestPrice && trade.highestPrice > trade.buyPrice && trade.buyPrice > 0) {
        const peakGain = peakPnl;
        const currentDropFromPeak = ((trade.highestPrice - trade.currentPrice) / trade.highestPrice) * 100;

        // Adaptive trailing stop: Tighter stops as profit increases
        let trailingStopPercent = 15; // Default 15% from peak
        if (peakGain >= 50) {
          trailingStopPercent = 8; // Tight stop at 50%+ profit (protect big gains)
        } else if (peakGain >= 30) {
          trailingStopPercent = 10; // Medium stop at 30%+ profit
        } else if (peakGain >= 15) {
          trailingStopPercent = 12; // Slightly tighter at 15%+ profit
        }

        // If we've gained at least 10% and now dropped X% from peak, sell
        if (peakGain >= 10 && currentDropFromPeak >= trailingStopPercent) {
          addLog(`📉 ADAPTIVE TRAILING STOP: ${trade.symbol} dropped ${currentDropFromPeak.toFixed(1)}% from peak (${peakGain.toFixed(1)}% gain, ${trailingStopPercent}% stop). Selling...`);
          sellToken(trade.mint, 100);
          return;
        }
      }

      // Trailing Stop (for speed trading - explicit setting)
      if (exitStrategy.trailingStop && trade.highestPrice && trade.highestPrice > trade.buyPrice) {
        const peakGain = ((trade.highestPrice - trade.buyPrice) / trade.buyPrice) * 100;
        const trailingStopPercent = exitStrategy.trailingStopPercent || 10; // Default 10% from peak
        const currentDropFromPeak = ((trade.highestPrice - trade.currentPrice) / trade.highestPrice) * 100;

        // If we've gained at least 20% and now dropped X% from peak, sell
        if (peakGain >= 20 && currentDropFromPeak >= trailingStopPercent) {
          addLog(`📉 TRAILING STOP: ${trade.symbol} dropped ${currentDropFromPeak.toFixed(1)}% from peak (${peakGain.toFixed(1)}% gain). Selling...`);
          sellToken(trade.mint, 100);
          return;
        }
      }

      // Stop Loss (Immediate Exit)
      const stopLoss = exitStrategy.stopLoss || config.stopLoss;
      // Ensure we have valid PnL calculation
      if (trade.buyPrice > 0 && trade.currentPrice > 0) {
        const calculatedPnl = ((trade.currentPrice - trade.buyPrice) / trade.buyPrice) * 100;
        // Stop loss triggers when PnL is at or below the negative stop loss threshold
        if (calculatedPnl <= -Math.abs(stopLoss)) {
          addLog(`🛑 STOP LOSS Triggered for ${trade.symbol} at ${calculatedPnl.toFixed(2)}% (threshold: -${stopLoss}%)`);
          sellToken(trade.mint, 100);
          return;
        }
      }

      // Fallback: Use stored PnL if calculation failed (check both calculated and stored)
      const pnlToCheck = trade.pnlPercent !== undefined ? trade.pnlPercent :
        (trade.buyPrice > 0 && trade.currentPrice > 0 ?
          ((trade.currentPrice - trade.buyPrice) / trade.buyPrice) * 100 : 0);
      if (pnlToCheck <= -Math.abs(stopLoss) && trade.buyPrice > 0) {
        addLog(`🛑 STOP LOSS Triggered for ${trade.symbol} at ${pnlToCheck.toFixed(2)}% (threshold: -${stopLoss}%)`);
        sellToken(trade.mint, 100);
        return;
      }

      // Staged Profit Taking (Research: 50% at 2x, 30% at 5x, hold 20%)
      const takeProfit = exitStrategy.takeProfit || config.takeProfit;
      const takeProfit2 = exitStrategy.takeProfit2;
      const tp1SellPercent = getTp1SellPercent(exitStrategy);
      const tp2SellPercent = getTp2SellPercent(exitStrategy);

      // First profit target (2x = 100%) - Sell 50%
      if (currentPnl >= takeProfit && !hasTp1Sell(trade.partialSells)) {
        addLog(`🎯 STAGED TP1: ${trade.symbol} hit ${currentPnl.toFixed(1)}% (target: ${takeProfit}%). Selling 50%...`);
        addLog(`Moonbag mode: scaling ${trade.symbol} out by ${tp1SellPercent}% at TP1.`);
        sellToken(trade.mint, tp1SellPercent);
        // Mark 50% as sold
        updateTrade(trade.mint, { partialSells: { ...trade.partialSells, tp1: true, [String(tp1SellPercent)]: true } });
        return;
      }

      // MEDIUM MODE BREAK-EVEN PROTECTION: Sell 80% at 25% profit to reclaim original SOL
      // Only for Medium mode and only if takeProfit is set higher than 25%
      if (config.mode === 'medium' && currentPnl >= 25 && takeProfit > 25 && !trade.partialSells[80] && !trade.partialSells[50]) {
        addLog(`🛡️ BREAK-EVEN PROTECTION: ${trade.symbol} hit 25% profit. Selling 80% to secure original SOL...`);
        sellToken(trade.mint, 80);
        // Mark 80% as sold to prevent repeats or higher staged sells
        updateTrade(trade.mint, { partialSells: { ...trade.partialSells, 80: true } });
        return;
      }

      // Second profit target (5x = 400%) - Sell 30% more (total 80% sold, 20% held)
      if (takeProfit2 && currentPnl >= takeProfit2 && !hasTp2Sell(trade.partialSells)) {
        addLog(`🚀 STAGED TP2: ${trade.symbol} hit ${currentPnl.toFixed(1)}% (target: ${takeProfit2}%). Selling 30% more (20% held for lottery)...`);
        addLog(`Moonbag mode: scaling ${trade.symbol} out by ${tp2SellPercent}% at TP2 and tightening the runner floor.`);
        sellToken(trade.mint, tp2SellPercent);
        // Mark 80% as sold
        updateTrade(trade.mint, { partialSells: { ...trade.partialSells, tp1: true, tp2: true, [String(tp2SellPercent)]: true } });
        return;
      }

      // === VELOCITY MODE: CASCADING TAKE PROFIT (CTP) ===
      // Sells 25% of CURRENT balance at 25%, 50%, and 75% profit intervals
      if (config.mode === 'velocity' && trade.buyPrice > 0) {
        // TP at 25%
        if (currentPnl >= 25 && !trade.partialSells[25]) {
          addLog(`💰 VELOCITY CTP (25%): ${trade.symbol} hit 25% profit. Selling 25% of tokens...`);
          sellToken(trade.mint, 25);
          updateTrade(trade.mint, { partialSells: { ...trade.partialSells, 25: true } });
          return;
        }
        // TP at 50%
        if (currentPnl >= 50 && !trade.partialSells[51]) { // Use 51 to avoid overlap if 50 is used elsewhere
          addLog(`💰 VELOCITY CTP (50%): ${trade.symbol} hit 50% profit. Selling 25% of remaining tokens...`);
          sellToken(trade.mint, 25);
          updateTrade(trade.mint, { partialSells: { ...trade.partialSells, 51: true } });
          return;
        }
        // TP at 75%
        if (currentPnl >= 75 && !trade.partialSells[75]) {
          addLog(`💰 VELOCITY CTP (75%): ${trade.symbol} hit 75% profit. Selling 25% of remaining tokens (25% Moonbag remains)...`);
          sellToken(trade.mint, 25);
          updateTrade(trade.mint, { partialSells: { ...trade.partialSells, 75: true } });
          return;
        }
      }

      // Standard take profit (if no staged exits configured)
      if (!takeProfit2 && currentPnl >= takeProfit) {
        addLog(`🎯 TAKE PROFIT Triggered for ${trade.symbol} at ${currentPnl.toFixed(2)}%`);
        sellToken(trade.mint, 100);
        return;
      }

      if (config.isDemo && trade.buyTime && trade.buyPrice > 0 && trade.currentPrice > 0) {
        const holdTime = holdTimeSeconds;

        // Exit stale positions in paper trading (no movement for 2 minutes)
        if (holdTime >= 120 && Math.abs(currentPnl) < 2) {
          addLog(`⏱️ STALE POSITION: ${trade.symbol} no movement after ${Math.floor(holdTime)}s. Exiting...`);
          sellToken(trade.mint, 100);
          return;
        }
      }
    });
  }, [activeTrades, config.isRunning, config.takeProfit, config.stopLoss, config.isDemo, config.mode, config.advanced?.slippage, buyToken, sellToken, addLog, updateTrade]);

  if (!mounted) return <div className="min-h-screen bg-[#050505] text-white" />;

  return (
    <main className="min-h-screen bg-[#050505] text-white font-sans selection:bg-[var(--primary)] selection:text-white">
      {/* Top Navigation */}
      <header className="fixed top-0 left-0 right-0 h-16 border-b border-[#222] bg-[#050505]/95 backdrop-blur-md z-50 flex items-center justify-between px-6">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-black italic tracking-tighter bg-gradient-to-r from-[var(--primary)] to-[var(--secondary)] bg-clip-text text-transparent">
            MEME<span className="text-white">VELOCITY</span>
          </h1>
          <span className="px-2 py-0.5 rounded text-[10px] border border-[#333] text-gray-400 font-mono">
            v1.0 BETA
          </span>
        </div>

        <nav className="flex gap-1 bg-[#121212] p-1 rounded-lg border border-[#222]">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'dashboard' ? 'bg-[#222] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
          >
            <LayoutDashboard size={14} /> Dashboard
          </button>
          <button
            onClick={() => setActiveTab('wallet')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'wallet' ? 'bg-[#222] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
          >
            <Wallet size={14} /> Wallet
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'settings' ? 'bg-[#222] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
          >
            <Settings size={14} /> Bot Config
          </button>
        </nav>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className={`w-2 h-2 rounded-full ${config.isRunning ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
              {config.isRunning ? "RUNNING" : "STOPPED"}
            </div>
            <div className="h-4 w-[1px] bg-[#333]"></div>
            {config.isDemo && (
              <span className="text-xs font-bold text-blue-400 bg-blue-500/10 px-2 py-1 rounded">DEMO MODE</span>
            )}
            {!config.isDemo && wallet && (
              <span className="text-xs font-bold text-red-400 bg-red-500/10 px-2 py-1 rounded">LIVE WALLET MODE</span>
            )}
          </div>
        </header>

      {/* Main Content Area */}
      <div className="pt-24 px-6 pb-20 max-w-[1600px] mx-auto">

        {/* Statistics Widget Row - Always visible on dashboard */}
        {activeTab === 'dashboard' && (
          <DashboardStats
            realBalance={realBalance}
            demoBalance={demoBalance}
            isDemo={config.isDemo}
            stats={displayedStats}
            heliusKey={config.heliusKey}
          />
        )}

        <div className="grid grid-cols-12 gap-6">

          {/* Left Sidebar / Column (3 Cols) */}
          <div className={`col-span-12 lg:col-span-4 xl:col-span-3 space-y-6 ${activeTab !== 'dashboard' ? 'hidden' : ''}`}>
            {/* Mini Wallet Widget */}
            {!wallet && (
              <div className="p-6 rounded-xl border border-yellow-500/20 bg-yellow-500/5 text-yellow-500 text-center">
                <AlertOctagon className="mx-auto mb-2 opacity-50" />
                <p className="font-bold text-sm">No Wallet Connected</p>
                <p className="text-xs opacity-70 mt-1">Go to Wallet tab to create or import.</p>
              </div>
            )}

            {/* Quick Bot Toggle */}
            <div className="glass-panel p-4">
              <h3 className="text-sm font-bold glow-text mb-4 text-gray-400">Quick Actions</h3>
              <BotControls onConfigChange={handleConfigChange} walletConnected={!!wallet || config.isDemo} realBalance={realBalance} config={config} />
            </div>

            <div className="glass-panel p-4">
              <h3 className="font-bold mb-3 flex items-center gap-2 text-gray-400 text-sm">
                <Activity size={14} /> Decision Pulse
              </h3>
              <div className="grid grid-cols-2 gap-2 mb-4">
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/8 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-amber-300/70">Waits</div>
                  <div className="text-lg font-semibold text-amber-300">{decisionPulse.counts.wait}</div>
                </div>
                <div className="rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-red-300/70">Rejects</div>
                  <div className="text-lg font-semibold text-red-300">{decisionPulse.counts.reject}</div>
                </div>
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/8 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-emerald-300/70">Approvals</div>
                  <div className="text-lg font-semibold text-emerald-300">{decisionPulse.counts.approve}</div>
                </div>
                <div className="rounded-lg border border-sky-500/20 bg-sky-500/8 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-sky-300/70">Entries</div>
                  <div className="text-lg font-semibold text-sky-300">{decisionPulse.counts.buy}</div>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <div className="mb-2 text-[10px] uppercase tracking-wide text-gray-500">Mode Breakdown</div>
                  <div className="space-y-2">
                    {decisionPulse.modeStats.length > 0 ? decisionPulse.modeStats.map((mode) => {
                      const modePressure = Math.max(1, mode.total);
                      const waitWidth = (mode.waits / modePressure) * 100;
                      const rejectWidth = (mode.rejects / modePressure) * 100;
                      const approveWidth = ((mode.approvals + mode.buys) / modePressure) * 100;

                      return (
                        <div key={mode.mode} className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="font-semibold text-gray-300">{mode.mode}</span>
                            <span className="text-gray-500">{mode.total} signals</span>
                          </div>
                          <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-white/5">
                            <div className="h-full bg-amber-400/80" style={{ width: `${waitWidth}%` }} />
                            <div className="h-full bg-red-400/80" style={{ width: `${rejectWidth}%` }} />
                            <div className="h-full bg-emerald-400/80" style={{ width: `${approveWidth}%` }} />
                          </div>
                          <div className="mt-2 flex justify-between text-[10px] text-gray-500">
                            <span>W {mode.waits}</span>
                            <span>R {mode.rejects}</span>
                            <span>A {mode.approvals + mode.buys}</span>
                          </div>
                        </div>
                      );
                    }) : (
                      <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-3 text-[11px] text-gray-500">
                        No structured signals yet.
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-[10px] uppercase tracking-wide text-gray-500">Top Reasons</div>
                  <div className="space-y-2">
                    {decisionPulse.topReasons.length > 0 ? decisionPulse.topReasons.map((reason) => {
                      const width = decisionPulse.topReasons[0]?.count ? (reason.count / decisionPulse.topReasons[0].count) * 100 : 0;
                      return (
                        <div key={reason.label} className="space-y-1">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="truncate text-gray-300">{reason.label}</span>
                            <span className="text-gray-500">{reason.count}</span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
                            <div className="h-full rounded-full bg-[var(--primary)]/70" style={{ width: `${width}%` }} />
                          </div>
                        </div>
                      );
                    }) : (
                      <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-3 text-[11px] text-gray-500">
                        Waiting for enough logs to classify.
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-[10px] uppercase tracking-wide text-gray-500">Recent Signals</div>
                  <div className="flex flex-wrap gap-2">
                    {decisionPulse.recentSignals.length > 0 ? decisionPulse.recentSignals.map((signal, index) => (
                      <div
                        key={`${signal.raw}-${index}`}
                        className={`rounded-full border px-2.5 py-1 text-[10px] font-mono ${
                          signal.kind === 'reject'
                            ? 'border-red-500/20 bg-red-500/10 text-red-300'
                            : signal.kind === 'wait'
                              ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
                              : signal.kind === 'buy' || signal.kind === 'approve'
                                ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
                                : 'border-white/10 bg-white/[0.04] text-gray-400'
                        }`}
                        title={signal.reason}
                      >
                        {signal.mode} {signal.token}
                      </div>
                    )) : (
                      <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-3 text-[11px] text-gray-500">
                        Live decisions will appear here.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* System Logs */}
            <div className="glass-panel p-4 h-[260px] flex flex-col">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-bold flex items-center gap-2 text-gray-400 text-sm">
                <Terminal size={14} /> System Logs
                </h3>
                <span className="text-[10px] uppercase tracking-wide text-gray-500">{decisionPulse.totalSignals} parsed</span>
              </div>
              <div className="flex-1 overflow-y-auto text-[10px] font-mono text-gray-500 space-y-1 custom-scrollbar">
                {logs.map((log, i) => (
                  <div key={i} className="border-l-2 border-transparent hover:border-[var(--primary)] pl-2 break-all">
                    {log}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Main Center Area (Stats & Active Trades) */}
          <div className={`${activeTab === 'dashboard' ? 'col-span-12 lg:col-span-8 xl:col-span-6' : 'hidden'}`}>
            <div className="space-y-6">
              <ActiveTrades trades={displayedActiveTrades} onSell={sellToken} onSync={syncTrades} onRecover={recoverTrades} onClearAll={clearTrades} onCleanup={cleanupWaste} isCleaning={isCleaning} />
              <TradeHistory trades={displayedTradeHistory} />
            </div>
          </div>

          {/* Right Feed Column */}
          <div className={`col-span-12 xl:col-span-3 ${activeTab === 'dashboard' ? 'block' : 'hidden'}`}>
            <LiveFeed onTokenDetected={onTokenDetected} isDemo={config.isDemo} isSimulating={config.isSimulating} heliusKey={config.heliusKey} />
          </div>

          {/* Logic for Tab Switching Views */}
          {/* Wallet Tab - Always mounted, hidden if not active */}
          <div className={`col-span-12 flex justify-center animate-fade-in ${activeTab === 'wallet' ? 'block' : 'hidden'}`}>
            <div className="w-full max-w-2xl">
              <WalletManager
                onWalletChange={handleWalletChange}
                onBalanceChange={setRealBalance}
                connection={connection}
                vaultBalance={vaultBalance}
                profitProtectionEnabled={profitProtectionEnabled}
                profitProtectionPercent={profitProtectionPercent}
                onWithdrawVault={withdrawFromVault}
                onMoveVaultToTrading={moveVaultToTrading}
                onToggleProfitProtection={toggleProfitProtection}
                onSetProfitProtectionPercent={setProfitProtectionPercentage}
                onClearVault={clearVault}
                isDemo={config.isDemo}
              />
            </div>
          </div>

          {/* Settings Tab - Always mounted, hidden if not active */}
          <div className={`col-span-12 flex justify-center animate-fade-in ${activeTab === 'settings' ? 'block' : 'hidden'}`}>
            <div className="w-full max-w-2xl">
              <BotControls onConfigChange={handleConfigChange} walletConnected={!!wallet || config.isDemo} config={config} />
            </div>
          </div>

        </div>
      </div>
    </main>
  );
}
