"use client";

import React, { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { createConnection } from '../utils/solanaManager';
import { usePumpTrader } from '../hooks/usePumpTrader';
import { TokenData } from '../components/LiveFeed';
import { AlertOctagon, Terminal, LayoutDashboard, Wallet, Settings } from 'lucide-react';
import { quickFirstBuyerCheck, analyzeFirstBuyer } from '../utils/firstBuyer';
import { quickSpeedCheck, analyzeSpeedTrade } from '../utils/speedTrader';
import { analyzeEnhanced } from '../utils/enhancedAnalyzer';

// Dynamic imports for components
const WalletManager = dynamic(() => import('../components/WalletManager'), { ssr: false });
const BotControls = dynamic(() => import('../components/BotControls'), { ssr: false });
const LiveFeed = dynamic(() => import('../components/LiveFeed'), { ssr: false });
const ActiveTrades = dynamic(() => import('../components/ActiveTrades'), { ssr: false });
const DashboardStats = dynamic(() => import('../components/DashboardStats'), { ssr: false });
const TradeHistory = dynamic(() => import('../components/TradeHistory'), { ssr: false });

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [wallet, setWallet] = useState<any>(null);
  // Initialize config with Helius key from localStorage if available (client-side only)
  const [config, setConfig] = useState<any>(() => {
    if (typeof window !== 'undefined') {
      const savedHelius = localStorage.getItem('helius_api_key') || '';
      return { isRunning: false, mode: 'safe', amount: 0.01, takeProfit: 30, stopLoss: 10, isDemo: false, isSimulating: false, heliusKey: savedHelius, maxConcurrentTrades: 5 };
    }
    return { isRunning: false, mode: 'safe', amount: 0.01, takeProfit: 30, stopLoss: 10, isDemo: false, isSimulating: false, heliusKey: '', maxConcurrentTrades: 5 };
  });
  const [activeTab, setActiveTab] = useState<'dashboard' | 'wallet' | 'settings'>('dashboard');
  const [realBalance, setRealBalance] = useState(0);

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
    console.log(`[page.tsx] Connection useEffect - config.heliusKey: ${config.heliusKey ? config.heliusKey.substring(0, 8) + '...' : 'empty'}`);
    if (config.heliusKey) {
      console.log(`[page.tsx] Updating connection with Helius key: ${config.heliusKey.substring(0, 8)}...`);
      setConnection(createConnection(config.heliusKey));
    } else {
      console.log(`[page.tsx] No Helius key, using public RPC`);
      setConnection(createConnection());
    }
  }, [config.heliusKey]);

  const {
    activeTrades,
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
    vaultBalance,
    profitProtectionEnabled,
    profitProtectionPercent,
    withdrawFromVault,
    moveVaultToTrading,
    toggleProfitProtection,
    setProfitProtectionPercentage
  } = usePumpTrader(wallet?.keypair, connection, config.heliusKey);
  const [tradeHistory, setTradeHistory] = useState<Set<string>>(new Set());
  const [lastTradeTime, setLastTradeTime] = useState<number>(0);
  const minTimeBetweenTrades = 500; // Reduced to 500ms to catch rapid pumps (was 2s)

  const handleWalletChange = (newWallet: any) => {
    setWallet(newWallet);
  };

  const handleConfigChange = (newConfig: any) => {
    setConfig(newConfig);
    setDemoMode(newConfig.isDemo);
  };

  const onTokenDetected = useCallback(async (token: TokenData) => {
    console.log("[onTokenDetected] Token received:", token.mint, "isRunning:", config.isRunning, "isDemo:", config.isDemo);

    // Only act if bot is running
    if (!config.isRunning) {
      return;
    }
    // Rate limiting: Minimum time between trades
    const timeSinceLastTrade = Date.now() - lastTradeTime;
    if (timeSinceLastTrade < minTimeBetweenTrades) {
      addLog(`⏱️ Rate limit: Waiting ${((minTimeBetweenTrades - timeSinceLastTrade) / 1000).toFixed(1)}s before next trade`);
      return;
    }

    // Limit concurrent trades
    const openTradesCount = activeTrades.filter(t => t.status === "open").length;
    if (openTradesCount >= (config.maxConcurrentTrades || 1)) {
      addLog(`Max open trades (${config.maxConcurrentTrades || 1}) reached, skipping ${token.symbol}.`);
      return;
    }

    if (!wallet && !config.isDemo) {
      return;
    }

    // Duplication check within session
    if (tradeHistory.has(token.mint)) {
      return;
    }

    // === ADVANCED RUG DETECTION (Early Filter) ===
    // This catches obvious scams BEFORE expensive analysis
    const { detectRug } = await import('../utils/rugDetector');
    const rugDetection = detectRug(token, config.mode);

    if (rugDetection.isRug) {
      addLog(`🚨 RUG DETECTED: ${token.symbol} - ${rugDetection.reason} (Confidence: ${rugDetection.confidence}%)`);
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

    // Auto-stop if balance is critical (ONLY for real trading)
    if (!config.isDemo && realBalance < 0.015) {
      addLog("⚠️ CRITICAL BALANCE: Auto-stopping bot to save gas.");
      setConfig((prev: any) => ({ ...prev, isRunning: false }));
      return;
    }

    // Demo mode: Stop if balance gets too low (prevent burning through all demo SOL)
    if (config.isDemo) {
      // This will be checked in buyToken, but we can add a warning here
      // The actual check happens in usePumpTrader
    }

    // === FIRST BUYER MODE (Buy immediately, sell after 6s) ===
    if (config.mode === 'first') {
      try {
        // Quick pre-filter
        const quickCheck = quickFirstBuyerCheck(token);
        if (!quickCheck.passed) {
          addLog(`🚀 First Reject: ${token.symbol} - ${quickCheck.reason}`);
          return;
        }

        // First buyer analysis (ultra-early entry)
        const firstSignal = await analyzeFirstBuyer(token, connection);

        if (!firstSignal.shouldBuy || firstSignal.confidence < 60) {
          addLog(`🚀 First Reject: ${token.symbol} - ${firstSignal.reason} (Confidence: ${firstSignal.confidence}%)`);
          return;
        }

        // Log first buyer signal
        addLog(`🚀 FIRST BUYER: ${token.symbol} - ${firstSignal.reason}`);
        addLog(`   Confidence: ${firstSignal.confidence}% | Entry Time: ${new Date(firstSignal.entryTime).toLocaleTimeString()}`);
        const tp2Text = firstSignal.exitStrategy.takeProfit2 ? `, 30% @ ${firstSignal.exitStrategy.takeProfit2}%` : '';
        addLog(`   Exit Strategy: ${firstSignal.exitStrategy.timeBasedExit}s hold | Staged: 50% @ ${firstSignal.exitStrategy.takeProfit}%${tp2Text} | SL ${firstSignal.exitStrategy.stopLoss}%`);

        setTradeHistory(prev => new Set(prev).add(token.mint));

        // Calculate initial price from token data
        // Demo mode uses REAL tokens, so always calculate from real token data
        let initialPrice: number | undefined;
        if (token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0) {
          initialPrice = (token.vSolInBondingCurve / token.vTokensInBondingCurve) * 1000000;
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

        // Use position size from analysis (research-based sizing)
        const tradeAmount = firstSignal.exitStrategy.positionSize || config.amount;
        addLog(`   💰 Position Size: ${tradeAmount} SOL (confidence-based)`);

        // Buy with exit strategy and research-based position size
        setLastTradeTime(Date.now());
        await buyToken(token.mint, token.symbol, tradeAmount, 15, initialPrice, exitStrategy);
        return;
      } catch (error: any) {
        addLog(`❌ First Buyer Error for ${token.symbol}: ${error.message}`);
        return;
      }
    }

    // === SPEED TRADING MODE (SCALP) ===
    if (config.mode === 'scalp') {
      try {
        // Quick pre-filter
        const quickCheck = quickSpeedCheck(token);
        if (!quickCheck.passed) {
          addLog(`⚡ Speed Reject: ${token.symbol} - ${quickCheck.reason}`);
          return;
        }

        // Speed trading analysis (momentum-based)
        const speedSignal = await analyzeSpeedTrade(token, connection);

        if (!speedSignal.shouldBuy || speedSignal.confidence < 50) {
          addLog(`⚡ Speed Reject: ${token.symbol} - ${speedSignal.reason} (Confidence: ${speedSignal.confidence}%)`);
          return;
        }

        // Log speed trading signal
        addLog(`⚡ SPEED BUY: ${token.symbol} - ${speedSignal.reason}`);
        addLog(`   Confidence: ${speedSignal.confidence}% | Momentum: ${speedSignal.momentum.toFixed(2)} SOL/min`);
        addLog(`   Exit Strategy: TP ${speedSignal.exitStrategy.takeProfit}% | SL ${speedSignal.exitStrategy.stopLoss}% | Max Hold: ${speedSignal.exitStrategy.maxHoldTime}s`);

        setTradeHistory(prev => new Set(prev).add(token.mint));

        // Calculate initial price from token data
        // Demo mode uses REAL tokens, so always calculate from real token data
        let initialPrice: number | undefined;
        if (token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0) {
          initialPrice = (token.vSolInBondingCurve / token.vTokensInBondingCurve) * 1000000;
        } else {
          // Price will be fetched from blockchain in buyToken if not available here
          initialPrice = undefined;
        }

        // Buy with exit strategy
        setLastTradeTime(Date.now());
        await buyToken(token.mint, token.symbol, config.amount, 15, initialPrice, speedSignal.exitStrategy);
        return;
      } catch (error: any) {
        addLog(`❌ Speed Trading Error for ${token.symbol}: ${error.message}`);
        return;
      }
    }

    // === HIGH RISK MODE: MOMENTUM-BASED FAST TRACK ===
    // For High Risk mode, prioritize new tokens with fast momentum
    // BUT: Still respect rug detection - don't buy obvious scams!
    if (config.mode === 'high') {
      try {
        const age = (Date.now() - token.timestamp) / 1000; // Age in seconds
        const liquidityGrowth = (token.vSolInBondingCurve || 30) - 30;

        // Calculate momentum (liquidity growth rate)
        const momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0; // SOL per minute

        // FAST TRACK: Very new tokens (<60s) with strong momentum
        // BUT: Must pass basic rug checks (liquidity, not crashed, etc.)
        if (age < 60 && momentum > 1.5 && liquidityGrowth > 2 && liquidityGrowth >= 0 && (token.vSolInBondingCurve || 30) >= 1) {
          addLog(`🚀 HIGH RISK FAST TRACK: ${token.symbol} - ${age.toFixed(0)}s old, ${momentum.toFixed(1)} SOL/min momentum, +${liquidityGrowth.toFixed(2)} SOL`);
          addLog(`   ⚡ NEW + MOMENTUM: Early momentum play (rug checks passed)`);

          setTradeHistory(prev => new Set(prev).add(token.mint));
          const initialPrice = token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0
            ? (token.vSolInBondingCurve / token.vTokensInBondingCurve) * 1000000
            : undefined;

          setLastTradeTime(Date.now());
          await buyToken(token.mint, token.symbol, config.amount, 15, initialPrice);
          return;
        }

        // FAST TRACK: New tokens (<2 min) with very strong momentum (>3 SOL/min)
        // BUT: Must pass basic rug checks
        if (age < 120 && momentum > 3 && liquidityGrowth > 5 && liquidityGrowth >= 0 && (token.vSolInBondingCurve || 30) >= 1) {
          addLog(`🚀 HIGH RISK FAST TRACK: ${token.symbol} - ${age.toFixed(0)}s old, ${momentum.toFixed(1)} SOL/min momentum, +${liquidityGrowth.toFixed(2)} SOL`);
          addLog(`   ⚡ STRONG MOMENTUM: High buy activity detected (rug checks passed)`);

          setTradeHistory(prev => new Set(prev).add(token.mint));
          const initialPrice = token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0
            ? (token.vSolInBondingCurve / token.vTokensInBondingCurve) * 1000000
            : undefined;

          setLastTradeTime(Date.now());
          await buyToken(token.mint, token.symbol, config.amount, 15, initialPrice);
          return;
        }
      } catch (error: any) {
        // If fast track fails, fall through to normal analysis
        addLog(`⚠️ Fast track error for ${token.symbol}, using normal analysis: ${error.message}`);
      }
    }

    // === ENHANCED TOKEN ANALYSIS (Safe/Medium/High modes) - Based on Research ===
    try {
      // ENTRY CONFIRMATION: Wait for momentum confirmation before buying
      // This prevents buying into dead tokens
      const age = (Date.now() - token.timestamp) / 1000;
      const liquidityGrowth = (token.vSolInBondingCurve || 30) - 30;
      const momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0;

      // 1. SNIPER TRAP CHECK: If token pumped too fast (>20 SOL in <30s), it's likely a bot trap
      if (age < 30 && liquidityGrowth > 20 && config.mode !== 'high' && config.mode !== 'first') {
        addLog(`🚨 Sniper Trap Avoided: ${token.symbol} pumped +${liquidityGrowth.toFixed(2)} SOL in ${age.toFixed(1)}s. Too risky.`);
        return;
      }

      // 2. DEAD TOKEN CHECK: If token is old (>2m) with no momentum, skip
      if (age > 120 && momentum < 0.1 && config.mode !== 'high') {
        addLog(`💤 Dead Token: ${token.symbol} is ${Math.floor(age / 60)}m old with 0 momentum. Skipping.`);
        return;
      }

      // 3. ORGANIC CONFIRMATION: For new tokens (<30s), wait for some activity (unless high risk mode)
      if (age < 30 && config.mode !== 'high' && config.mode !== 'first' && config.mode !== 'scalp') {
        if (liquidityGrowth < 0.5) {
          addLog(`⏳ Waiting for confirmation: ${token.symbol} too new (${age.toFixed(1)}s) with low activity (+${liquidityGrowth.toFixed(2)} SOL). Skipping...`);
          return;
        }
      }

      // Full enhanced analysis
      // NOTE: Demo mode uses REAL tokens, not simulated ones
      // Only skip analysis for SIM tokens in simulation mode (not demo mode)
      let analysis;
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
          metrics: {
            holderCount: 100,
            deployerHoldings: 10,
            top10Concentration: 40,
            volume24h: 5,
            buySellRatio: 0.7,
            bondingCurveVelocity: 0.5,
            liquidityDepth: token.vSolInBondingCurve || 30,
            contractSecurity: { freezeAuthority: true, mintAuthority: true, updateAuthority: true }
          }
        };
      } else {
        // Enhanced analysis for real tokens (based on research)
        // Pass risk mode to analyzer so it can adjust strictness
        // Custom mode uses medium risk level (balanced approach)
        const riskMode = config.mode === 'high' ? 'high' : config.mode === 'medium' || config.mode === 'custom' ? 'medium' : 'safe';
        analysis = await analyzeEnhanced(token, connection, config.heliusKey, riskMode, config.advanced);
      }

      // Mode-based filtering with analysis scores
      // IMPORTANT: High-risk mode should still have MINIMUM quality standards
      // "High risk" means buying newer/smaller tokens, NOT buying obvious scams

      // Base thresholds - High risk mode is more lenient on age/size, but still needs quality
      let minScore = config.mode === 'safe' ? 65 : config.mode === 'medium' || config.mode === 'custom' ? 50 : 40; // Increased from 30 to 40 for high-risk
      if (config.isDemo) {
        // Paper trading: Lower thresholds to allow more trades for testing
        minScore = config.mode === 'safe' ? 55 : config.mode === 'medium' || config.mode === 'custom' ? 40 : 30; // Increased from 25 to 30 for high-risk
      }

      // For high-risk mode with strong momentum, we can be slightly more lenient
      // But still maintain minimum quality (don't go below 25 in real mode, 20 in demo)
      if (config.mode === 'high' && age < 120 && momentum > 2) {
        minScore = config.isDemo ? 20 : 25; // Still maintain quality standards
      }

      // If RPC is failing (analysis might be incomplete), be very lenient
      // Check if analysis has warnings about RPC issues
      const hasRpcIssues = analysis.warnings.some(w => w.includes('RPC') || w.includes('Access denied') || w.includes('rate limit') || w.includes('basic analysis'));
      if (config.isDemo && hasRpcIssues) {
        // If RPC is failing, accept tokens with lower scores (analysis is incomplete)
        minScore = Math.max(10, minScore - 20); // Lower by 20 points, minimum 10
        addLog(`⚠️ RPC issues detected - lowering score threshold to ${minScore} for ${token.symbol}`);
      }

      if (analysis.score < minScore) {
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

      if (!analysis.passed) {
        addLog(`🚫 Failed Analysis: ${token.symbol} - ${analysis.reasons.join(', ')}`);
        return;
      }

      // Log enhanced analysis results
      addLog(`✅ APPROVED: ${token.symbol} - Score: ${analysis.score}/100 (${analysis.riskLevel} risk)`);
      addLog(`   📊 Bonding Curve: ${analysis.bondingCurveProgress.toFixed(1)}% | Market Cap: ${analysis.marketCap.toFixed(1)} SOL`);
      addLog(`   👥 Holders: ${analysis.metrics.holderCount} | Deployer: ${analysis.metrics.deployerHoldings.toFixed(1)}% | Top 10: ${analysis.metrics.top10Concentration.toFixed(1)}%`);
      addLog(`   💰 Volume: ${analysis.metrics.volume24h.toFixed(1)} SOL | Buy Ratio: ${(analysis.metrics.buySellRatio * 100).toFixed(0)}%`);
      addLog(`   ⚡ Velocity: ${analysis.metrics.bondingCurveVelocity.toFixed(2)}%/min | Liquidity: ${analysis.metrics.liquidityDepth.toFixed(1)} SOL`);

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
      const scoreMultiplier = Math.max(0.5, Math.min(2.0, (analysis.score / 50))); // 0.5x to 2.0x
      positionSize = config.amount * scoreMultiplier;

      // Portfolio heat management: Reduce position size if too many trades open
      const openTradesCount = activeTrades.filter(t => t.status === "open").length;
      if (openTradesCount >= 3) {
        positionSize *= 0.7; // Reduce by 30% if 3+ trades open
      } else if (openTradesCount >= 2) {
        positionSize *= 0.85; // Reduce by 15% if 2 trades open
      }

      // Cap position size for safety
      positionSize = Math.min(positionSize, config.amount * 2); // Never more than 2x base
      positionSize = Math.max(positionSize, config.amount * 0.3); // Never less than 0.3x base

      if (Math.abs(positionSize - config.amount) > 0.001) {
        addLog(`💰 Position Size: ${positionSize.toFixed(4)} SOL (${scoreMultiplier > 1 ? '+' : ''}${((scoreMultiplier - 1) * 100).toFixed(0)}% based on score ${analysis.score})`);
      }

      console.log("[onTokenDetected] ✅ Executing buy for:", token.symbol, "Amount:", positionSize.toFixed(4), "SOL", "Score:", analysis.score, "Curve:", analysis.bondingCurveProgress.toFixed(1) + "%");
      setTradeHistory(prev => new Set(prev).add(token.mint));

      const initialPrice = token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0
        ? (token.vSolInBondingCurve / token.vTokensInBondingCurve) * 1000000
        : undefined;

      setLastTradeTime(Date.now());
      // ADAPTIVE SLIPPAGE: Higher for riskier/faster modes
      const dynamicSlippage = (config.mode === 'high' || config.mode === 'scalp' || config.mode === 'first') ? 25 : 15;
      await buyToken(token.mint, token.symbol, positionSize, dynamicSlippage, initialPrice);
    } catch (error: any) {
      addLog(`❌ Analysis Error for ${token.symbol}: ${error.message}`);
      console.error("Token analysis error:", error);
      // Fallback to old simple check for safety
      const initialBuySol = (token.vSolInBondingCurve || 30) - 30;
      if (config.mode === 'safe' && initialBuySol < 2.0) {
        addLog(`Fallback: Skipping ${token.symbol} - Dev Buy too low`);
        return;
      }
      // Custom mode: User has full control, proceed if they've configured it
      // Other modes: Proceed if not in safe mode
      if (config.mode === 'custom' || config.mode !== 'safe') {
        setTradeHistory(prev => new Set(prev).add(token.mint));
        // Calculate initial price from token data
        // Demo mode uses REAL tokens, so always calculate from real token data
        let initialPrice: number | undefined;
        if (token.vSolInBondingCurve > 0 && token.vTokensInBondingCurve > 0) {
          initialPrice = (token.vSolInBondingCurve / token.vTokensInBondingCurve) * 1000000;
        } else {
          // Price will be fetched from blockchain in buyToken if not available here
          initialPrice = undefined;
        }
        setLastTradeTime(Date.now());
        const dynamicSlippage = (config.mode === 'high' || config.mode === 'scalp' || config.mode === 'first') ? 25 : 15;
        await buyToken(token.mint, token.symbol, config.amount, dynamicSlippage, initialPrice);
      }
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
            addLog(`[${trade.symbol}] Using currentPrice as buyPrice (${trade.currentPrice.toFixed(9)})`);
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
        trailingStopPercent: undefined
      };

      // Time-based exit (for speed trading and first buyer)
      if (trade.buyTime && exitStrategy.maxHoldTime < Infinity) {
        const holdTime = (Date.now() - trade.buyTime) / 1000; // seconds
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

      // Momentum-based exit (for first buyer mode)
      if (exitStrategy.momentumExit && trade.buyTime) {
        const holdTime = (Date.now() - trade.buyTime) / 1000;
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
        const holdTime = (Date.now() - trade.buyTime) / 1000;
        if (holdTime < 10) {
          return;
        }
      }

      // Profit Protection: If we're in profit but price starts dropping, exit quickly
      // This prevents giving back profits on meme tokens
      if (trade.buyPrice > 0 && trade.currentPrice > 0 && trade.highestPrice) {
        const currentPnl = ((trade.currentPrice - trade.buyPrice) / trade.buyPrice) * 100;
        const peakPnl = ((trade.highestPrice - trade.buyPrice) / trade.buyPrice) * 100;

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
      if (trade.highestPrice && trade.highestPrice > trade.buyPrice && trade.buyPrice > 0) {
        const peakGain = ((trade.highestPrice - trade.buyPrice) / trade.buyPrice) * 100;
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

      // Initialize partial sells tracking if not exists
      if (!trade.partialSells) {
        updateTrade(trade.mint, { partialSells: {} });
        return; // Wait for next cycle
      }

      // Calculate current PnL to ensure accuracy
      let currentPnl = trade.pnlPercent;
      if (trade.buyPrice > 0 && trade.currentPrice > 0) {
        currentPnl = ((trade.currentPrice - trade.buyPrice) / trade.buyPrice) * 100;
      }

      // First profit target (2x = 100%) - Sell 50%
      if (currentPnl >= takeProfit && !trade.partialSells[50]) {
        addLog(`🎯 STAGED TP1: ${trade.symbol} hit ${currentPnl.toFixed(1)}% (target: ${takeProfit}%). Selling 50%...`);
        sellToken(trade.mint, 50);
        // Mark 50% as sold
        updateTrade(trade.mint, { partialSells: { ...trade.partialSells, 50: true } });
        return;
      }

      // Second profit target (5x = 400%) - Sell 30% more (total 80% sold, 20% held)
      if (takeProfit2 && currentPnl >= takeProfit2 && !trade.partialSells[80]) {
        addLog(`🚀 STAGED TP2: ${trade.symbol} hit ${currentPnl.toFixed(1)}% (target: ${takeProfit2}%). Selling 30% more (20% held for lottery)...`);
        sellToken(trade.mint, 30);
        // Mark 80% as sold
        updateTrade(trade.mint, { partialSells: { ...trade.partialSells, 80: true } });
        return;
      }

      // Standard take profit (if no staged exits configured)
      if (!takeProfit2 && currentPnl >= takeProfit) {
        addLog(`🎯 TAKE PROFIT Triggered for ${trade.symbol} at ${currentPnl.toFixed(2)}%`);
        sellToken(trade.mint, 100);
        return;
      }

      // Paper Trading: Quick exit on small profits to test system more frequently
      // Exit at 5% profit if held for more than 30 seconds (for testing)
      if (config.isDemo && trade.buyTime && trade.buyPrice > 0 && trade.currentPrice > 0) {
        const holdTime = (Date.now() - trade.buyTime) / 1000;
        const quickProfit = ((trade.currentPrice - trade.buyPrice) / trade.buyPrice) * 100;

        // If we're up 5%+ and held for 30+ seconds, take profit (paper trading optimization)
        if (quickProfit >= 5 && holdTime >= 30 && currentPnl < takeProfit) {
          addLog(`📊 PAPER TRADING QUICK EXIT: ${trade.symbol} up ${quickProfit.toFixed(1)}% after ${Math.floor(holdTime)}s. Taking profit...`);
          sellToken(trade.mint, 100);
          return;
        }

        // Exit stale positions in paper trading (no movement for 2 minutes)
        if (holdTime >= 120 && Math.abs(currentPnl) < 2) {
          addLog(`⏱️ STALE POSITION: ${trade.symbol} no movement after ${Math.floor(holdTime)}s. Exiting...`);
          sellToken(trade.mint, 100);
          return;
        }
      }
    });
  }, [activeTrades, config.isRunning, config.takeProfit, config.stopLoss, config.isDemo, sellToken, addLog, updateTrade]);

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
            stats={stats}
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
              <BotControls onConfigChange={handleConfigChange} walletConnected={!!wallet || config.isDemo} realBalance={realBalance} />
            </div>

            {/* System Logs */}
            <div className="glass-panel p-4 h-[300px] flex flex-col">
              <h3 className="font-bold mb-2 flex items-center gap-2 text-gray-400 text-sm">
                <Terminal size={14} /> System Logs
              </h3>
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
              <ActiveTrades trades={activeTrades} onSell={sellToken} onSync={syncTrades} onRecover={recoverTrades} onClearAll={clearTrades} />
              <TradeHistory trades={activeTrades} />
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
                isDemo={config.isDemo}
              />
            </div>
          </div>

          {/* Settings Tab - Always mounted, hidden if not active */}
          <div className={`col-span-12 flex justify-center animate-fade-in ${activeTab === 'settings' ? 'block' : 'hidden'}`}>
            <div className="w-full max-w-2xl">
              <BotControls onConfigChange={handleConfigChange} walletConnected={!!wallet || config.isDemo} />
            </div>
          </div>

        </div>
      </div>
    </main>
  );
}
