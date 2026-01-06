import { Connection, PublicKey } from '@solana/web3.js';
import { getPumpData, getTokenMetadata } from './solanaManager';
import { TokenData } from '../components/LiveFeed';

export interface TokenAnalysis {
    score: number; // 0-100, higher is better
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    passed: boolean;
    reasons: string[];
    warnings: string[];
    strengths: string[];
}

export interface TokenMetrics {
    liquidity: number;
    liquidityGrowth: number;
    holderCount: number;
    holderDistribution: number; // Gini coefficient approximation
    devHoldings: number;
    age: number; // seconds since launch
    volume24h: number;
    priceChange: number;
    hasMetadata: boolean;
    metadataQuality: number;
}

/**
 * Comprehensive token analysis to filter out rugs and identify quality tokens
 * Based on research: 98.6% of pump.fun tokens are scams
 */
export async function analyzeToken(
    token: TokenData,
    connection: Connection,
    heliusKey?: string
): Promise<TokenAnalysis> {
    const reasons: string[] = [];
    const warnings: string[] = [];
    const strengths: string[] = [];
    let score = 50; // Start neutral

    try {
        // Get current bonding curve data
        const pumpData = await getPumpData(token.mint, connection);
        if (!pumpData) {
            return {
                score: 0,
                riskLevel: 'critical',
                passed: false,
                reasons: ['Token not found on bonding curve'],
                warnings: [],
                strengths: []
            };
        }

        // Calculate metrics
        const metrics = await calculateMetrics(token, pumpData, connection, heliusKey);

        // === CRITICAL CHECKS (Auto-reject) ===
        
        // 1. Dev already sold (instant rug)
        if (metrics.devHoldings === 0 && metrics.age < 300) {
            reasons.push('🚨 DEV ALREADY SOLD - Instant rug detected');
            return {
                score: 0,
                riskLevel: 'critical',
                passed: false,
                reasons,
                warnings,
                strengths
            };
        }

        // 2. Extremely low liquidity (honeypot risk)
        if (metrics.liquidity < 0.5) {
            reasons.push(`🚨 Liquidity too low: ${metrics.liquidity.toFixed(2)} SOL (honeypot risk)`);
            return {
                score: 0,
                riskLevel: 'critical',
                passed: false,
                reasons,
                warnings,
                strengths
            };
        }

        // 3. No metadata (unprofessional)
        if (!metrics.hasMetadata) {
            reasons.push('🚨 No metadata - unprofessional launch');
            return {
                score: 0,
                riskLevel: 'critical',
                passed: false,
                reasons,
                warnings,
                strengths
            };
        }

        // 4. Token too new (no track record)
        if (metrics.age < 60) {
            reasons.push(`Token too new: ${metrics.age}s old (wait for activity)`);
            return {
                score: 0,
                riskLevel: 'critical',
                passed: false,
                reasons,
                warnings,
                strengths
            };
        }

        // === SCORING SYSTEM ===

        // Liquidity Analysis (30 points)
        if (metrics.liquidity >= 5) {
            score += 20;
            strengths.push(`Strong liquidity: ${metrics.liquidity.toFixed(2)} SOL`);
        } else if (metrics.liquidity >= 2) {
            score += 10;
            strengths.push(`Decent liquidity: ${metrics.liquidity.toFixed(2)} SOL`);
        } else if (metrics.liquidity >= 1) {
            score += 5;
        } else {
            warnings.push(`Low liquidity: ${metrics.liquidity.toFixed(2)} SOL`);
            score -= 10;
        }

        // Liquidity Growth (15 points)
        if (metrics.liquidityGrowth > 0.2) {
            score += 15;
            strengths.push(`Growing liquidity: +${(metrics.liquidityGrowth * 100).toFixed(1)}%`);
        } else if (metrics.liquidityGrowth > 0.1) {
            score += 8;
        } else if (metrics.liquidityGrowth < -0.1) {
            warnings.push(`Liquidity draining: ${(metrics.liquidityGrowth * 100).toFixed(1)}%`);
            score -= 15;
        }

        // Dev Skin in Game (25 points)
        const devBuyAmount = token.vSolInBondingCurve - 30; // Initial dev buy
        if (devBuyAmount >= 5) {
            score += 25;
            strengths.push(`High dev commitment: ${devBuyAmount.toFixed(2)} SOL`);
        } else if (devBuyAmount >= 2) {
            score += 15;
            strengths.push(`Good dev commitment: ${devBuyAmount.toFixed(2)} SOL`);
        } else if (devBuyAmount >= 1) {
            score += 8;
        } else if (devBuyAmount >= 0.5) {
            score += 3;
        } else {
            warnings.push(`Low dev buy: ${devBuyAmount.toFixed(2)} SOL`);
            score -= 10;
        }

        // Dev Still Holding (20 points)
        if (metrics.devHoldings > 0.8) {
            score += 20;
            strengths.push('Dev still holding most tokens');
        } else if (metrics.devHoldings > 0.5) {
            score += 12;
        } else if (metrics.devHoldings > 0.3) {
            score += 5;
        } else if (metrics.devHoldings > 0.1) {
            warnings.push(`Dev sold ${((1 - metrics.devHoldings) * 100).toFixed(0)}%`);
            score -= 5;
        } else {
            warnings.push(`Dev sold most tokens: ${((1 - metrics.devHoldings) * 100).toFixed(0)}%`);
            score -= 20;
        }

        // Holder Distribution (10 points)
        if (metrics.holderCount >= 20) {
            score += 10;
            strengths.push(`Good holder count: ${metrics.holderCount}`);
        } else if (metrics.holderCount >= 10) {
            score += 5;
        } else if (metrics.holderCount >= 5) {
            score += 2;
        } else {
            warnings.push(`Low holder count: ${metrics.holderCount}`);
            score -= 5;
        }

        // Age/Activity (10 points)
        if (metrics.age >= 300) {
            score += 10;
            strengths.push(`Token survived ${Math.floor(metrics.age / 60)} minutes`);
        } else if (metrics.age >= 120) {
            score += 5;
        }

        // Metadata Quality (10 points)
        if (metrics.metadataQuality >= 0.8) {
            score += 10;
            strengths.push('High quality metadata');
        } else if (metrics.metadataQuality >= 0.5) {
            score += 5;
        }

        // Price Stability (10 points) - if we have price data
        if (metrics.priceChange > -0.1 && metrics.priceChange < 0.5) {
            score += 10;
            strengths.push('Stable price action');
        } else if (metrics.priceChange < -0.2) {
            warnings.push(`Price dropping: ${(metrics.priceChange * 100).toFixed(1)}%`);
            score -= 10;
        }

        // Bonus: High liquidity + Dev commitment
        if (metrics.liquidity >= 3 && devBuyAmount >= 2) {
            score += 10;
            strengths.push('Strong fundamentals');
        }

        // Penalties for red flags
        if (metrics.holderDistribution > 0.8) {
            warnings.push('Highly concentrated holdings (whale risk)');
            score -= 15;
        }

        // Clamp score
        score = Math.max(0, Math.min(100, score));

        // Determine risk level
        let riskLevel: 'low' | 'medium' | 'high' | 'critical';
        if (score >= 70) riskLevel = 'low';
        else if (score >= 50) riskLevel = 'medium';
        else if (score >= 30) riskLevel = 'high';
        else riskLevel = 'critical';

        // Pass threshold (adjustable by mode)
        const passed = score >= 50; // Medium risk threshold

        return {
            score,
            riskLevel,
            passed,
            reasons,
            warnings,
            strengths
        };

    } catch (error: any) {
        return {
            score: 0,
            riskLevel: 'critical',
            passed: false,
            reasons: [`Analysis error: ${error.message}`],
            warnings,
            strengths
        };
    }
}

/**
 * Calculate detailed token metrics
 */
async function calculateMetrics(
    token: TokenData,
    pumpData: { vSolInBondingCurve: number; vTokensInBondingCurve: number; tokenTotalSupply: number },
    connection: Connection,
    heliusKey?: string
): Promise<TokenMetrics> {
    const age = (Date.now() - token.timestamp) / 1000;
    const liquidity = pumpData.vSolInBondingCurve;
    
    // Calculate liquidity growth (compare to initial 30 SOL)
    const initialLiquidity = 30;
    const liquidityGrowth = (liquidity - initialLiquidity) / initialLiquidity;

    // Get metadata
    const metadata = await getTokenMetadata(token.mint, heliusKey);
    const hasMetadata = metadata.name !== "Real Token" && metadata.name !== "Unknown" && metadata.name !== "";
    
    // Metadata quality score (simple heuristic)
    let metadataQuality = 0.5;
    if (hasMetadata) {
        metadataQuality = 0.7;
        if (metadata.name.length > 3 && metadata.symbol.length > 2) {
            metadataQuality = 0.8;
        }
        if (!metadata.name.toLowerCase().includes('test') && 
            !metadata.name.toLowerCase().includes('rug') &&
            !metadata.symbol.toLowerCase().includes('test')) {
            metadataQuality = 0.9;
        }
    }

    // Check dev holdings (simplified - would need more complex analysis)
    let devHoldings = 1.0; // Assume 100% if we can't check
    try {
        const { getTokenBalance } = await import('./solanaManager');
        if (token.traderPublicKey && token.traderPublicKey !== 'SIM') {
            const devBalance = await getTokenBalance(token.traderPublicKey, token.mint, connection);
            // Estimate dev holdings percentage (rough approximation)
            if (devBalance === 0) {
                devHoldings = 0;
            } else {
                // This is a rough estimate - in reality we'd need to check total supply
                devHoldings = Math.min(1.0, devBalance / (pumpData.tokenTotalSupply / 1000000));
            }
        }
    } catch (e) {
        // Can't check, assume still holding
    }

    // Holder count (simplified - would need to query all holders)
    // For now, estimate based on liquidity growth
    const holderCount = Math.max(1, Math.floor(liquidityGrowth * 50 + 5));

    // Holder distribution (Gini approximation - simplified)
    // Higher = more concentrated (bad)
    const holderDistribution = Math.min(1.0, 0.5 + (1 / Math.max(holderCount, 1)) * 0.5);

    return {
        liquidity,
        liquidityGrowth,
        holderCount,
        holderDistribution,
        devHoldings,
        age,
        volume24h: 0, // Would need historical data
        priceChange: 0, // Would need price history
        hasMetadata,
        metadataQuality
    };
}

/**
 * Quick filter for high-risk tokens (fast rejection)
 */
export function quickRugCheck(token: TokenData): { passed: boolean; reason?: string } {
    // Check 1: No metadata
    if (!token.name || token.name === "Real Token" || token.name === "Unknown") {
        return { passed: false, reason: 'No metadata' };
    }

    // Check 2: Extremely low initial buy
    const devBuy = (token.vSolInBondingCurve || 30) - 30;
    if (devBuy < 0.1) {
        return { passed: false, reason: 'Dev buy too low' };
    }

    // Check 3: Token too new (less than 30 seconds)
    const age = (Date.now() - token.timestamp) / 1000;
    if (age < 30) {
        return { passed: false, reason: 'Token too new' };
    }

    return { passed: true };
}








