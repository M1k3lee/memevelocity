import { Connection } from '@solana/web3.js';
import { getPumpData } from './solanaManager';
import { TokenData } from '../components/LiveFeed';

export interface SpeedTradeSignal {
    shouldBuy: boolean;
    confidence: number; // 0-100
    reason: string;
    momentum: number; // Liquidity growth rate
    riskLevel: 'low' | 'medium' | 'high';
    exitStrategy: {
        takeProfit: number; // Percentage
        stopLoss: number; // Percentage
        maxHoldTime: number; // Seconds
        trailingStop: boolean;
    };
}

/**
 * Speed Trading Analyzer - For quick in-and-out trades on early launches
 * Strategy: Buy very early, exit quickly before rug pull
 */
export async function analyzeSpeedTrade(
    token: TokenData,
    connection: Connection,
    previousData?: { liquidity: number; timestamp: number }
): Promise<SpeedTradeSignal> {
    try {
        const currentData = await getPumpData(token.mint, connection);
        if (!currentData) {
            return {
                shouldBuy: false,
                confidence: 0,
                reason: 'Token not found',
                momentum: 0,
                riskLevel: 'high',
                exitStrategy: {
                    takeProfit: 50,
                    stopLoss: 15,
                    maxHoldTime: 180,
                    trailingStop: true
                }
            };
        }

        const age = (Date.now() - token.timestamp) / 1000; // Age in seconds
        const liquidity = currentData.vSolInBondingCurve;
        const initialLiquidity = 30; // Pump.fun starts at 30 SOL
        const liquidityGrowth = liquidity - initialLiquidity;
        const liquidityGrowthPercent = (liquidityGrowth / initialLiquidity) * 100;

        // Calculate momentum (liquidity growth rate)
        let momentum = 0;
        if (previousData && age > 0) {
            const liquidityChange = liquidity - previousData.liquidity;
            const timeDiff = (Date.now() - previousData.timestamp) / 1000;
            momentum = timeDiff > 0 ? (liquidityChange / timeDiff) * 60 : 0; // SOL per minute
        } else {
            // Estimate momentum from current growth
            momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0;
        }

        // === SPEED TRADING CRITERIA ===

        // CRITICAL REJECTIONS (instant rug indicators)
        if (age < 5) {
            return {
                shouldBuy: false,
                confidence: 0,
                reason: 'Token too new (<5s) - wait for initial activity',
                momentum: 0,
                riskLevel: 'high',
                exitStrategy: {
                    takeProfit: 50,
                    stopLoss: 15,
                    maxHoldTime: 180,
                    trailingStop: true
                }
            };
        }

        // Check if dev already sold (instant rug)
        // This would need to check dev wallet, but for speed we'll use heuristics
        if (liquidityGrowth < -5 && age < 60) {
            return {
                shouldBuy: false,
                confidence: 0,
                reason: '🚨 Liquidity draining - possible instant rug',
                momentum: momentum,
                riskLevel: 'high',
                exitStrategy: {
                    takeProfit: 50,
                    stopLoss: 15,
                    maxHoldTime: 180,
                    trailingStop: true
                }
            };
        }

        // === MOMENTUM-BASED SIGNALS ===

        let confidence = 0;
        let reason = '';
        let riskLevel: 'low' | 'medium' | 'high' = 'high';

        // STRONG MOMENTUM SIGNAL (Best case)
        if (momentum > 2 && age < 120 && liquidityGrowth > 5) {
            confidence = 85;
            reason = `🔥 STRONG MOMENTUM: +${liquidityGrowth.toFixed(1)} SOL in ${age.toFixed(0)}s (${momentum.toFixed(1)} SOL/min)`;
            riskLevel = 'low';
        }
        // GOOD MOMENTUM SIGNAL
        else if (momentum > 1 && age < 180 && liquidityGrowth > 2) {
            confidence = 70;
            reason = `⚡ GOOD MOMENTUM: +${liquidityGrowth.toFixed(1)} SOL growth (${momentum.toFixed(1)} SOL/min)`;
            riskLevel = 'medium';
        }
        // EARLY CATCH (Very early, some activity)
        else if (momentum > 0.5 && age < 60 && liquidityGrowth > 0.5) {
            confidence = 60;
            reason = `⚡ EARLY CATCH: Growing liquidity (${momentum.toFixed(1)} SOL/min)`;
            riskLevel = 'medium';
        }
        // NEUTRAL (Some activity but not strong)
        else if (liquidityGrowth > 0 && age < 300) {
            confidence = 40;
            reason = `📊 NEUTRAL: Some activity (+${liquidityGrowth.toFixed(1)} SOL)`;
            riskLevel = 'high';
        }
        // WEAK SIGNAL
        else if (liquidityGrowth >= 0) {
            confidence = 25;
            reason = `⚠️ WEAK: Minimal growth (+${liquidityGrowth.toFixed(1)} SOL)`;
            riskLevel = 'high';
        }
        // NEGATIVE (Reject)
        else {
            return {
                shouldBuy: false,
                confidence: 0,
                reason: `❌ REJECT: Negative growth (${liquidityGrowth.toFixed(1)} SOL)`,
                momentum: momentum,
                riskLevel: 'high',
                exitStrategy: {
                    takeProfit: 50,
                    stopLoss: 15,
                    maxHoldTime: 180,
                    trailingStop: true
                }
            };
        }

        // === AGE-BASED ADJUSTMENTS ===
        // Older tokens are less attractive for speed trading
        if (age > 300) {
            confidence -= 20;
            reason += ' (Token aging)';
        } else if (age > 180) {
            confidence -= 10;
        }

        // === MOMENTUM BONUS ===
        if (momentum > 3) {
            confidence += 10;
            reason += ' [HIGH MOMENTUM]';
        }

        // Clamp confidence
        confidence = Math.max(0, Math.min(100, confidence));

        // === EXIT STRATEGY (Adaptive based on momentum) ===
        let takeProfit = 50; // Default 50%
        let stopLoss = 15; // Default 15%
        let maxHoldTime = 180; // Default 3 minutes

        if (momentum > 2) {
            // Strong momentum = higher TP, longer hold
            takeProfit = 100; // 2x target
            stopLoss = 20;
            maxHoldTime = 300; // 5 minutes
        } else if (momentum > 1) {
            // Good momentum = moderate TP
            takeProfit = 75; // 1.75x target
            stopLoss = 18;
            maxHoldTime = 240; // 4 minutes
        } else {
            // Weak momentum = quick exit
            takeProfit = 50; // 1.5x target
            stopLoss = 15;
            maxHoldTime = 180; // 3 minutes
        }

        // Very early tokens (<30s) = quick scalps
        if (age < 30 && momentum > 0.5) {
            takeProfit = 30; // Quick 30% profit
            stopLoss = 10; // Tight stop
            maxHoldTime = 120; // 2 minutes max
        }

        return {
            shouldBuy: confidence >= 50, // Buy if confidence >= 50%
            confidence,
            reason,
            momentum,
            riskLevel,
            exitStrategy: {
                takeProfit,
                stopLoss,
                maxHoldTime,
                trailingStop: true // Always use trailing stop for speed trades
            }
        };

    } catch (error: any) {
        return {
            shouldBuy: false,
            confidence: 0,
            reason: `Analysis error: ${error.message}`,
            momentum: 0,
            riskLevel: 'high',
            exitStrategy: {
                takeProfit: 50,
                stopLoss: 15,
                maxHoldTime: 180,
                trailingStop: true
            }
        };
    }
}

/**
 * Quick pre-filter for speed trading (ultra-fast rejection)
 */
export function quickSpeedCheck(token: TokenData): { passed: boolean; reason?: string } {
    const age = (Date.now() - token.timestamp) / 1000;
    
    // Too old for speed trading
    if (age > 600) {
        return { passed: false, reason: 'Token too old for speed trade' };
    }

    // Check for negative liquidity growth
    const liquidityGrowth = (token.vSolInBondingCurve || 30) - 30;
    if (liquidityGrowth < -2) {
        return { passed: false, reason: 'Liquidity draining' };
    }

    return { passed: true };
}








