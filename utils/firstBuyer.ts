import { Connection } from '@solana/web3.js';
import { getPumpData } from './solanaManager';
import { TokenData } from '../components/LiveFeed';

export interface FirstBuyerSignal {
    shouldBuy: boolean;
    confidence: number; // 0-100
    reason: string;
    entryTime: number; // Timestamp
    exitStrategy: {
        timeBasedExit: number; // Seconds to hold (default 6)
        momentumExit: boolean; // Exit when momentum detected
        minHoldTime: number; // Minimum seconds before exit (e.g., 2)
        takeProfit: number; // Percentage (2x target - sell 50%)
        takeProfit2?: number; // Percentage (5x target - sell 30% more)
        stopLoss: number; // Percentage
        positionSize: number; // SOL amount based on confidence
    };
}

/**
 * First Buyer Mode - Buy immediately, sell after 6 seconds or when momentum detected
 * Strategy: Be first to buy, profit from early pump, exit before rug
 */
export async function analyzeFirstBuyer(
    token: TokenData,
    connection: Connection,
    previousData?: { liquidity: number; timestamp: number }
): Promise<FirstBuyerSignal> {
    try {
        const currentData = await getPumpData(token.mint, connection);
        if (!currentData) {
            return {
                shouldBuy: false,
                confidence: 0,
                reason: 'Token not found or RPC error',
                entryTime: Date.now(),
                exitStrategy: {
                    timeBasedExit: 6,
                    momentumExit: true,
                    minHoldTime: 3,
                    takeProfit: 30,
                    stopLoss: 10,
                    positionSize: 0.01
                }
            };
        }

        const age = (Date.now() - token.timestamp) / 1000; // Age in seconds
        const liquidity = currentData.vSolInBondingCurve;
        const initialLiquidity = 30; // Pump.fun starts at 30 SOL
        const liquidityGrowth = liquidity - initialLiquidity;

        // Calculate momentum (liquidity growth rate)
        let momentum = 0;
        if (previousData && age > 0) {
            const liquidityChange = liquidity - previousData.liquidity;
            const timeDiff = (Date.now() - previousData.timestamp) / 1000;
            momentum = timeDiff > 0 ? (liquidityChange / timeDiff) * 60 : 0; // SOL per minute
        } else {
            momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0;
        }

        // === FIRST BUYER CRITERIA ===
        // Must be VERY early (within 10 seconds ideally)
        // Must have some initial activity (dev buy or first buyers)

        let confidence = 0;
        let reason = '';
        let shouldBuy = false;

        // REJECT if too old (missed the window)
        if (age > 15) {
            return {
                shouldBuy: false,
                confidence: 0,
                reason: `Too late - token is ${age.toFixed(1)}s old (need <15s)`,
                entryTime: Date.now(),
                exitStrategy: {
                    timeBasedExit: 6,
                    momentumExit: true,
                    minHoldTime: 3,
                    takeProfit: 30,
                    stopLoss: 10,
                    positionSize: 0.01
                }
            };
        }

        // REJECT if liquidity is draining (instant rug)
        if (liquidityGrowth < -1) {
            return {
                shouldBuy: false,
                confidence: 0,
                reason: '🚨 Liquidity draining - instant rug',
                entryTime: Date.now(),
                exitStrategy: {
                    timeBasedExit: 6,
                    momentumExit: true,
                    minHoldTime: 3,
                    takeProfit: 30,
                    stopLoss: 10,
                    positionSize: 0.01
                }
            };
        }

        // === ENTRY SIGNALS ===

        // PERFECT: Very early (<5s) with some activity
        if (age < 5 && liquidityGrowth > 0.1) {
            confidence = 90;
            reason = `⚡ FIRST BUYER: ${age.toFixed(1)}s old, +${liquidityGrowth.toFixed(2)} SOL`;
            shouldBuy = true;
        }
        // GOOD: Early (<10s) with activity
        else if (age < 10 && liquidityGrowth > 0.2) {
            confidence = 75;
            reason = `⚡ EARLY BUYER: ${age.toFixed(1)}s old, +${liquidityGrowth.toFixed(2)} SOL`;
            shouldBuy = true;
        }
        // OKAY: Still early (<15s) with decent activity
        else if (age < 15 && liquidityGrowth > 0.5) {
            confidence = 60;
            reason = `⚡ QUICK BUY: ${age.toFixed(1)}s old, +${liquidityGrowth.toFixed(2)} SOL`;
            shouldBuy = true;
        }
        // MOMENTUM DETECTED: Others are buying
        else if (momentum > 1 && age < 12) {
            confidence = 70;
            reason = `📈 MOMENTUM: ${momentum.toFixed(1)} SOL/min detected`;
            shouldBuy = true;
        }
        // TOO LATE or NO ACTIVITY
        else {
            return {
                shouldBuy: false,
                confidence: 0,
                reason: `No signal - Age: ${age.toFixed(1)}s, Growth: ${liquidityGrowth.toFixed(2)} SOL`,
                entryTime: Date.now(),
                exitStrategy: {
                    timeBasedExit: 6,
                    momentumExit: true,
                    minHoldTime: 3,
                    takeProfit: 30,
                    stopLoss: 10,
                    positionSize: 0.01
                }
            };
        }

        // === EXIT STRATEGY (Research-Based: Staged Profit Taking) ===
        // Strategy: 50% at 2x, 30% at 5x, hold 20% for lottery
        // Research: Never allocate >0.5 SOL to single unknown token
        
        // Position sizing based on confidence (research-based)
        let positionSize = 0.01; // Default small position
        if (confidence >= 90) {
            positionSize = 0.05; // High confidence: up to 0.05 SOL
        } else if (confidence >= 75) {
            positionSize = 0.03; // Good confidence: 0.03 SOL
        } else if (confidence >= 60) {
            positionSize = 0.02; // Moderate confidence: 0.02 SOL
        }
        // Cap at 0.05 SOL max (research: never >0.5 SOL, but for 6s trades we use smaller)
        
        let timeBasedExit = 6; // Default 6 seconds (research target: <2.5s detection-to-execution)
        let takeProfit = 100; // 2x target (100% gain) - sell 50%
        let takeProfit2 = 400; // 5x target (400% gain) - sell 30% more (hold 20% for lottery)
        let stopLoss = 20; // Hard stop (research: exit if >20% loss)
        let minHoldTime = 2; // Minimum 2 seconds (allow for execution latency)

        // Adjust based on momentum and bonding curve position
        if (momentum > 2) {
            // Strong momentum - hold slightly longer for bigger gains
            timeBasedExit = 8;
            takeProfit = 150; // 2.5x target
            takeProfit2 = 500; // 6x target
            stopLoss = 20;
        } else if (momentum > 1) {
            // Good momentum - standard staged exits
            timeBasedExit = 6;
            takeProfit = 100; // 2x target
            takeProfit2 = 400; // 5x target
            stopLoss = 20;
        } else {
            // Weak momentum - exit faster, take profits early
            timeBasedExit = 5;
            takeProfit = 50; // 1.5x target (quick profit)
            takeProfit2 = 200; // 3x target
            stopLoss = 15;
        }

        // Very early entries (<3s) - ultra-fast exits (beat other bots)
        if (age < 3) {
            timeBasedExit = 4;
            takeProfit = 30; // Quick 30% profit
            takeProfit2 = 100; // 2x if it pumps
            stopLoss = 12;
            // Increase position slightly for ultra-early entries (higher risk/reward)
            if (confidence >= 85) {
                positionSize = Math.min(positionSize + 0.01, 0.05);
            }
        }
        
        // Check bonding curve progress - if already high, exit faster
        const bondingCurveProgress = age > 0 ? (liquidityGrowth / 30) * 100 : 0;
        if (bondingCurveProgress > 10) {
            // Already past sweet spot, exit quickly
            timeBasedExit = Math.min(timeBasedExit, 4);
            takeProfit = Math.min(takeProfit, 50);
        }

        return {
            shouldBuy,
            confidence,
            reason,
            entryTime: Date.now(),
            exitStrategy: {
                timeBasedExit,
                momentumExit: true, // Exit when momentum detected
                minHoldTime,
                takeProfit,
                takeProfit2,
                stopLoss,
                positionSize
            }
        };

    } catch (error: any) {
        // Handle rate limiting and RPC errors gracefully
        const errorMsg = error.message || String(error);
        const isRateLimit = errorMsg.includes('429') || errorMsg.includes('Too Many Requests');
        const isForbidden = errorMsg.includes('403') || errorMsg.includes('Forbidden');
        
        return {
            shouldBuy: false,
            confidence: 0,
            reason: isRateLimit 
                ? 'RPC rate limit - skipping' 
                : isForbidden 
                ? 'RPC access denied - check API key'
                : `Analysis error: ${errorMsg.substring(0, 50)}`,
            entryTime: Date.now(),
            exitStrategy: {
                timeBasedExit: 6,
                momentumExit: true,
                minHoldTime: 3,
                takeProfit: 30,
                stopLoss: 10,
                positionSize: 0.01
            }
        };
    }
}

/**
 * Quick check for first buyer mode (ultra-fast rejection)
 */
export function quickFirstBuyerCheck(token: TokenData): { passed: boolean; reason?: string } {
    const age = (Date.now() - token.timestamp) / 1000;
    
    // Too old
    if (age > 15) {
        return { passed: false, reason: 'Too old for first buyer' };
    }

    // Check for negative liquidity
    const liquidityGrowth = (token.vSolInBondingCurve || 30) - 30;
    if (liquidityGrowth < -1) {
        return { passed: false, reason: 'Liquidity draining' };
    }

    return { passed: true };
}

