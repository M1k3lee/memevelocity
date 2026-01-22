import { Connection, PublicKey } from '@solana/web3.js';
import { getPumpData, getTokenMetadata, getHolderStats, getHolderCount } from './solanaManager';
import { TokenData } from '../components/LiveFeed';

export interface AdvancedConfig {
    minBondingCurve?: number;
    maxBondingCurve?: number;
    minLiquidity?: number;
    minHolderCount?: number;
    maxDeployerHoldings?: number;
    minVolume24h?: number;
    maxDev?: number;
    maxTop10?: number;
    minVelocity?: number;
    rugCheckStrictness?: 'strict' | 'standard' | 'lenient';
}

export interface EnhancedAnalysis {
    score: number; // 0-100, higher is better
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    passed: boolean;
    reasons: string[];
    warnings: string[];
    strengths: string[];
    bondingCurveProgress: number; // 0-100%
    marketCap: number; // SOL
    metrics: {
        holderCount: number;
        deployerHoldings: number; // Percentage
        top10Concentration: number; // Percentage
        volume24h: number; // SOL
        buySellRatio: number; // 0-1 (1 = all buys)
        bondingCurveVelocity: number; // % per minute
        liquidityDepth: number; // SOL
        contractSecurity: {
            freezeAuthority: boolean; // true = revoked/null (good)
            mintAuthority: boolean; // true = revoked/null (good)
            updateAuthority: boolean; // true = revoked/null (good)
        };
    };
}

/**
 * Enhanced Token Analyzer based on institutional research
 * Focus: 5-15% bonding curve progress, holder distribution, volume validation
 */
export async function analyzeEnhanced(
    token: TokenData,
    connection: Connection,
    heliusKey?: string,
    riskMode: 'safe' | 'medium' | 'high' = 'medium',
    config?: AdvancedConfig
): Promise<EnhancedAnalysis> {
    const reasons: string[] = [];
    const warnings: string[] = [];
    const strengths: string[] = [];
    let score = 0; // Start at 0, build up

    // Default values if config is missing (backward compatibility)
    const minBondingCurve = config?.minBondingCurve ?? (riskMode === 'safe' ? 5 : riskMode === 'medium' ? 2 : 0);
    const maxBondingCurve = config?.maxBondingCurve ?? (riskMode === 'safe' ? 50 : 80);
    const minLiquidity = config?.minLiquidity ?? (riskMode === 'high' ? 1 : riskMode === 'medium' ? 5 : 10);
    const maxDev = config?.maxDev ?? (riskMode === 'high' ? 20 : 10);
    const maxTop10 = config?.maxTop10 ?? (riskMode === 'high' ? 80 : 60);
    const minVelocity = config?.minVelocity ?? 0;
    const age = (Date.now() - token.timestamp) / 1000; // Age in seconds

    // ADAPTIVE SAFETY: Scale holder requirement by age
    // New tokens (<2 mins) only need 15-20 holders to be "safe"
    const minHolders = config?.minHolderCount ?? (
        riskMode === 'high' ? 10 :
            age < 60 ? 15 :
                age < 120 ? 25 :
                    50
    );

    try {
        const pumpData = await getPumpData(token.mint, connection);
        if (!pumpData) {
            return createRejectResult('Token not found on bonding curve', reasons, warnings, strengths);
        }

        const age = (Date.now() - token.timestamp) / 1000; // Age in seconds
        const liquidity = pumpData.vSolInBondingCurve;
        const initialLiquidity = 30; // Pump.fun starts at 30 SOL
        const liquidityGrowth = liquidity - initialLiquidity;

        // === CRITICAL: BONDING CURVE PROGRESS ===
        // Formula: 100 - (((balance - 206,900,000) × 100) / 793,100,000)
        const tokenBalance = pumpData.vTokensInBondingCurve;
        const bondingCurveProgress = Math.max(0, Math.min(100,
            100 - (((tokenBalance - 206900000) * 100) / 793100000)
        ));

        // Sweet spot: 5-15% bonding curve progress ($3,500-$10,500 market cap)
        const marketCap = liquidity; // Approximate market cap in SOL

        // === CRITICAL REJECTIONS (Config-driven) ===

        const isHighRiskMode = riskMode === 'high';
        const isSafeMode = riskMode === 'safe';
        const strictness = config?.rugCheckStrictness ?? (isHighRiskMode ? 'lenient' : isSafeMode ? 'strict' : 'standard');

        // 2. Check contract security (CRITICAL - always check, but strictness varies)
        const contractSecurity = await checkContractSecurity(token.mint, connection);

        // Freeze authority = honeypot risk
        if (!contractSecurity.freezeAuthority) {
            if (strictness === 'lenient') {
                warnings.push('⚠️ FREEZE AUTHORITY ACTIVE - Honeypot risk (Lenient mode: proceeding)');
                score -= 15;
            } else {
                reasons.push('🚨 FREEZE AUTHORITY ACTIVE - Honeypot risk!');
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, marketCap, contractSecurity);
            }
        }

        // Mint authority = supply dilution
        if (!contractSecurity.mintAuthority) {
            if (strictness === 'lenient') {
                warnings.push('⚠️ MINT AUTHORITY ACTIVE - Supply dilution risk (Lenient mode: proceeding)');
                score -= 10;
            } else if (strictness === 'strict') {
                reasons.push('🚨 MINT AUTHORITY ACTIVE - Supply dilution risk!');
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, marketCap, contractSecurity);
            } else {
                warnings.push('⚠️ MINT AUTHORITY ACTIVE - Supply dilution risk');
                score -= 10;
            }
        }

        // SWEET SPOT BRIDGE: If token has high momentum (>1.5 SOL/min), loosen curves
        const currentLiquidity = pumpData.vSolInBondingCurve;
        const liquidityDelta = currentLiquidity - 30;
        const currentMomentum = (age > 0) ? (liquidityDelta / age) * 60 : 0;

        let effectiveMinCurve = minBondingCurve;
        if (currentMomentum > 1.5 && bondingCurveProgress < minBondingCurve) {
            effectiveMinCurve = 0; // Waiver for high momentum
            strengths.push(`🚀 Momentum Waiver: Strong growth (${currentMomentum.toFixed(1)} SOL/min) allows early entry`);
            score += 10; // High momentum bonus
        }

        // 1. Bonding curve timing
        if (bondingCurveProgress < effectiveMinCurve) {
            if (strictness === 'lenient' && bondingCurveProgress > 0) {
                warnings.push(`Early entry: ${bondingCurveProgress.toFixed(1)}% curve (<${effectiveMinCurve}%)`);
                score -= 5;
            } else {
                reasons.push(`Too early: ${bondingCurveProgress.toFixed(1)}% curve (min ${effectiveMinCurve}%)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, marketCap);
            }
        }

        if (bondingCurveProgress > maxBondingCurve) {
            reasons.push(`Too late: ${bondingCurveProgress.toFixed(1)}% curve (max ${maxBondingCurve}%)`);
            return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, marketCap);
        }

        // 3. Liquidity too low
        if (liquidity < minLiquidity) {
            reasons.push(`🚨 Liquidity too low: ${liquidity.toFixed(2)} SOL (min ${minLiquidity} SOL)`);
            return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, marketCap, contractSecurity);
        }

        // === SCORING SYSTEM (Based on Research) ===

        // 1. BONDING CURVE POSITION (25 points)
        if (bondingCurveProgress >= 5 && bondingCurveProgress <= 15) {
            score += 25; // Perfect sweet spot
            strengths.push(`Perfect entry window: ${bondingCurveProgress.toFixed(1)}% curve progress`);
        } else if (bondingCurveProgress >= 3 && bondingCurveProgress <= 20) {
            score += 15; // Good range
            strengths.push(`Good entry window: ${bondingCurveProgress.toFixed(1)}% curve progress`);
        } else if (bondingCurveProgress >= minBondingCurve && bondingCurveProgress <= maxBondingCurve) {
            score += 8; // Acceptable
        } else {
            warnings.push(`Outside optimal range: ${bondingCurveProgress.toFixed(1)}% curve`);
            score -= 5;
        }

        // 2. CONTRACT SECURITY (20 points - CRITICAL)
        if (contractSecurity.freezeAuthority && contractSecurity.mintAuthority) {
            score += 20;
            strengths.push('Contract security: All authorities revoked');
        } else if (contractSecurity.freezeAuthority) {
            score += 10;
            warnings.push('Mint authority still active');
        } else if (contractSecurity.mintAuthority) {
            if (strictness === 'lenient') {
                score += 5;
            } else {
                score -= 5;
            }
        } else {
            if (strictness === 'lenient') {
                score -= 5;
            } else {
                score -= 20;
            }
        }

        // 3. HOLDER DISTRIBUTION (20 points)
        const holderMetrics = await analyzeHolderDistribution(token.mint, connection, heliusKey);

        if (holderMetrics.holderCount < minHolders) {
            if (strictness === 'lenient' || age < 120) {
                warnings.push(`Low holder count: ${holderMetrics.holderCount} (min ${minHolders})`);
                score -= 10;
            } else {
                reasons.push(`Not enough holders: ${holderMetrics.holderCount} (min ${minHolders})`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, marketCap, contractSecurity);
            }
        }

        if (holderMetrics.holderCount >= 500) {
            score += 10;
            strengths.push(`Strong holder count: ${holderMetrics.holderCount}+`);
        } else if (holderMetrics.holderCount >= 200) {
            score += 6;
        } else if (holderMetrics.holderCount >= 100) {
            score += 3;
        }

        // Deployer holdings check
        if (holderMetrics.deployerHoldings > maxDev) {
            if (strictness === 'lenient' && holderMetrics.deployerHoldings < 30) {
                warnings.push(`High deployer holdings: ${holderMetrics.deployerHoldings.toFixed(1)}% (max ${maxDev}%)`);
                score -= 10;
            } else {
                reasons.push(`Deployer holds too much: ${holderMetrics.deployerHoldings.toFixed(1)}% (max ${maxDev}%)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, marketCap, contractSecurity);
            }
        }

        if (holderMetrics.deployerHoldings < 10) {
            score += 10;
            strengths.push(`Low deployer holdings: ${holderMetrics.deployerHoldings.toFixed(1)}%`);
        } else if (holderMetrics.deployerHoldings < 30) {
            score += 5;
        }

        // Top 10 concentration
        if (holderMetrics.top10Concentration > maxTop10) {
            if (strictness === 'lenient' && holderMetrics.top10Concentration < 90) {
                warnings.push(`High concentration: ${holderMetrics.top10Concentration.toFixed(1)}% (max ${maxTop10}%)`);
                score -= 10;
            } else {
                reasons.push(`Top 10 hold too much: ${holderMetrics.top10Concentration.toFixed(1)}% (max ${maxTop10}%)`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, marketCap, contractSecurity);
            }
        }

        if (holderMetrics.top10Concentration < 40) {
            score += 5;
            strengths.push(`Good distribution: Top 10 hold ${holderMetrics.top10Concentration.toFixed(1)}%`);
        } else if (holderMetrics.top10Concentration < 60) {
            score += 2;
        }

        // 4. VOLUME VALIDATION (15 points)
        const volumeMetrics = await analyzeVolume(token, age, liquidity, heliusKey);

        if (volumeMetrics.volume24h < (config?.minVolume24h || 0)) {
            warnings.push(`Low volume: ${volumeMetrics.volume24h.toFixed(1)} SOL (min ${config?.minVolume24h || 0})`);
            score -= 10;
        }

        if (volumeMetrics.volume24h > 10) {
            score += 10;
            strengths.push(`Strong volume: ${volumeMetrics.volume24h.toFixed(1)} SOL`);
        } else if (volumeMetrics.volume24h > 5) {
            score += 6;
        } else if (volumeMetrics.volume24h > 2) {
            score += 3;
        }

        // Buy/sell ratio
        if (volumeMetrics.buySellRatio > 0.65) {
            score += 5;
            strengths.push(`Strong buy pressure: ${(volumeMetrics.buySellRatio * 100).toFixed(0)}% buys`);
        } else if (volumeMetrics.buySellRatio > 0.5) {
            score += 2;
        } else {
            warnings.push(`Selling pressure: ${((1 - volumeMetrics.buySellRatio) * 100).toFixed(0)}% sells`);
            score -= 3;
        }

        // 5. BONDING CURVE VELOCITY (15 points)
        // Estimate velocity based on age and progress
        const bondingCurveVelocity = age > 0 ? (bondingCurveProgress / age) * 60 : 0; // % per minute

        if (bondingCurveVelocity < minVelocity) {
            warnings.push(`Low velocity: ${bondingCurveVelocity.toFixed(2)}%/min (min ${minVelocity})`);
            score -= 5;
        }

        // Calculate momentum (liquidity growth rate) - important for High Risk mode
        const momentum = age > 0 ? (liquidityGrowth / age) * 60 : 0; // SOL per minute

        if (bondingCurveVelocity > 0.5 && bondingCurveVelocity < 2) {
            score += 15;
            strengths.push(`Organic growth: ${bondingCurveVelocity.toFixed(2)}%/min`);
        } else if (bondingCurveVelocity > 2) {
            score += 5;
            warnings.push(`Rapid growth: ${bondingCurveVelocity.toFixed(2)}%/min (possible pump)`);
        } else if (bondingCurveVelocity < 0.1) {
            warnings.push(`Stalled growth: ${bondingCurveVelocity.toFixed(2)}%/min`);
            score -= 10;
        } else {
            score += 8;
        }

        // MOMENTUM BONUS (Extra points for High Risk mode or High Velocity config)
        if (isHighRiskMode || (config?.minVelocity || 0) > 0.5) {
            if (momentum > 3 && age < 120) {
                // Very strong momentum on new token
                score += 20;
                strengths.push(`🔥 STRONG MOMENTUM: ${momentum.toFixed(1)} SOL/min`);
            } else if (momentum > 1.5 && age < 180) {
                // Good momentum on relatively new token
                score += 15;
                strengths.push(`⚡ Good momentum: ${momentum.toFixed(1)} SOL/min`);
            } else if (momentum > 0.5 && age < 60) {
                // Early momentum on very new token
                score += 10;
                strengths.push(`📈 Early momentum: ${momentum.toFixed(1)} SOL/min`);
            }

            // Age bonus for very new tokens
            if (age < 30) {
                score += 25; // Significant bonus for catching it first
                strengths.push(`🔥 Brand New: ${age.toFixed(0)}s old - First Mover Advantage`);
            } else if (age < 60) {
                score += 15;
                strengths.push(`🆕 Very new: ${age.toFixed(0)}s old`);
            } else if (age < 120) {
                score += 10;
                strengths.push(`🆕 New: ${Math.floor(age / 60)}min old`);
            }
        }

        // 6. LIQUIDITY DEPTH (10 points)
        if (liquidity >= 20) {
            score += 10;
            strengths.push(`Deep liquidity: ${liquidity.toFixed(1)} SOL`);
        } else if (liquidity >= 10) {
            score += 6;
        } else if (liquidity >= 5) {
            score += 3;
        } else {
            warnings.push(`Thin liquidity: ${liquidity.toFixed(1)} SOL`);
        }

        // 7. AGE/ACTIVITY (5 points)
        if (age >= 300 && age <= 1800) {
            score += 5; // 5-30 minutes old is ideal
            strengths.push(`Optimal age: ${Math.floor(age / 60)} minutes`);
        } else if (age < 60) {
            warnings.push(`Very new: ${age.toFixed(0)}s old (wait for activity)`);
            score -= 3;
        }

        // 8. METADATA QUALITY (5 points)
        const metadata = await getTokenMetadata(token.mint, heliusKey);
        if (metadata.name && metadata.name !== "Real Token" && metadata.name !== "Unknown") {
            score += 5;
            strengths.push(`Has metadata: ${metadata.name}`);
        }

        // === BONUSES ===

        // Perfect sweet spot + good distribution
        if (bondingCurveProgress >= 5 && bondingCurveProgress <= 15 &&
            holderMetrics.holderCount >= 200 && holderMetrics.deployerHoldings < 10) {
            score += 10;
            strengths.push('Perfect setup: Sweet spot + good distribution');
        }

        // High Risk mode: Bonus for new tokens with high buy activity
        if ((isHighRiskMode || (config?.minVelocity || 0) > 0.5) && age < 120) {
            // Estimate buy activity from liquidity growth
            if (liquidityGrowth > 10) {
                score += 15;
                strengths.push(`💰 High buy activity: +${liquidityGrowth.toFixed(1)} SOL`);
            } else if (liquidityGrowth > 5) {
                score += 10;
                strengths.push(`💰 Good buy activity: +${liquidityGrowth.toFixed(1)} SOL`);
            } else if (liquidityGrowth > 2) {
                score += 5;
                strengths.push(`💰 Some buy activity: +${liquidityGrowth.toFixed(1)} SOL`);
            }
        }

        // === PENALTIES ===

        // High deployer + high concentration = rug risk
        if (holderMetrics.deployerHoldings > 30 && holderMetrics.top10Concentration > 60) {
            score -= 20;
            warnings.push('CRITICAL: High deployer + concentration = rug risk');
        }

        // Clamp score
        score = Math.max(0, Math.min(100, score));

        // Determine risk level
        let riskLevel: 'low' | 'medium' | 'high' | 'critical';
        if (score >= 70) riskLevel = 'low';
        else if (score >= 50) riskLevel = 'medium';
        else if (score >= 30) riskLevel = 'high';
        else riskLevel = 'critical';

        // Pass threshold varies by mode
        let passed: boolean;

        if (strictness === 'lenient') {
            // Lenient: Pass if score > 0 and liquidity > minLiquidity
            // For new tokens with momentum, be extremely lenient
            const finalMomentum = age > 0 ? (liquidityGrowth / age) * 60 : 0;
            if (age < 120 && finalMomentum > 1 && liquidity >= minLiquidity) {
                passed = score > 0;
                if (passed && finalMomentum > 2) {
                    strengths.push(`🚀 MOMENTUM PASS: ${finalMomentum.toFixed(1)} SOL/min momentum`);
                }
            } else {
                passed = score > 0 && liquidity >= minLiquidity;
            }
        } else if (strictness === 'strict') {
            // Strict: Require high score and specific bonding curve range
            passed = score >= 50 && bondingCurveProgress >= minBondingCurve && bondingCurveProgress <= maxBondingCurve;
        } else {
            // Standard: Balanced
            passed = score >= 30 && bondingCurveProgress >= minBondingCurve && bondingCurveProgress <= maxBondingCurve;
        }

        return {
            score,
            riskLevel,
            passed,
            reasons,
            warnings,
            strengths,
            bondingCurveProgress,
            marketCap,
            metrics: {
                holderCount: holderMetrics.holderCount,
                deployerHoldings: holderMetrics.deployerHoldings,
                top10Concentration: holderMetrics.top10Concentration,
                volume24h: volumeMetrics.volume24h,
                buySellRatio: volumeMetrics.buySellRatio,
                bondingCurveVelocity,
                liquidityDepth: liquidity,
                contractSecurity
            }
        };

    } catch (error: any) {
        // Handle rate limiting and RPC errors gracefully
        const errorMsg = error.message || String(error);
        const isRateLimit = errorMsg.includes('429') || errorMsg.includes('Too Many Requests');
        const isForbidden = errorMsg.includes('403') || errorMsg.includes('Forbidden') || errorMsg.includes('Access denied');

        // If we have basic token data from WebSocket, create a partial analysis
        if (token.vSolInBondingCurve && token.vTokensInBondingCurve) {
            const basicPrice = (token.vSolInBondingCurve / token.vTokensInBondingCurve) * 1000000;
            const basicLiquidity = token.vSolInBondingCurve;
            const basicBondingCurve = Math.max(0, Math.min(100,
                100 - (((token.vTokensInBondingCurve - 206900000) * 100) / 793100000)
            ));

            // Create a basic score based on available data
            let basicScore = 30; // Start with neutral score
            if (basicLiquidity > 50) basicScore += 10;
            if (basicLiquidity > 100) basicScore += 10;
            if (basicBondingCurve < 10) basicScore += 15; // Early in curve
            if (basicBondingCurve > 50) basicScore -= 10; // Late in curve

            warnings.push(isRateLimit
                ? 'RPC rate limit - using basic analysis'
                : isForbidden
                    ? 'RPC access denied - using basic analysis'
                    : `Analysis error - using basic analysis: ${errorMsg.substring(0, 30)}`);

            return {
                score: Math.max(10, Math.min(70, basicScore)),
                riskLevel: basicScore < 40 ? 'high' : basicScore < 60 ? 'medium' : 'low',
                passed: basicScore >= 20, // Lower threshold for basic analysis
                reasons: [...reasons, ...warnings],
                warnings,
                strengths: [...strengths, 'Basic liquidity data available'],
                bondingCurveProgress: basicBondingCurve,
                marketCap: basicLiquidity,
                metrics: {
                    holderCount: 0,
                    deployerHoldings: 0,
                    top10Concentration: 0,
                    volume24h: 0,
                    buySellRatio: 1,
                    bondingCurveVelocity: 0,
                    liquidityDepth: basicLiquidity,
                    contractSecurity: {
                        freezeAuthority: false,
                        mintAuthority: false,
                        updateAuthority: false
                    }
                }
            };
        }

        const errorReason = isRateLimit
            ? 'RPC rate limit - try again later'
            : isForbidden
                ? 'RPC access denied - check API key'
                : `Analysis error: ${errorMsg.substring(0, 50)}`;

        return createRejectResult(errorReason, reasons, warnings, strengths);
    }
}

/**
 * Check contract security (freeze authority, mint authority, update authority)
 */
async function checkContractSecurity(
    mintAddress: string,
    connection: Connection
): Promise<{ freezeAuthority: boolean; mintAuthority: boolean; updateAuthority: boolean }> {
    try {
        const mint = new PublicKey(mintAddress);
        const mintInfo = await connection.getParsedAccountInfo(mint);

        if (!mintInfo.value || !mintInfo.value.data || typeof mintInfo.value.data === 'string') {
            return { freezeAuthority: false, mintAuthority: false, updateAuthority: false };
        }

        const parsed = mintInfo.value.data as any;
        const freezeAuthority = parsed.parsed?.info?.freezeAuthority === null;
        const mintAuthority = parsed.parsed?.info?.mintAuthority === null;

        // Check metadata update authority
        // If we can't check update authority, assume it's okay if freeze/mint are null
        const updateAuthority = true; // Would need metadata program to check properly

        return {
            freezeAuthority,
            mintAuthority,
            updateAuthority
        };
    } catch (e) {
        // If we can't check, assume worst case
        return { freezeAuthority: false, mintAuthority: false, updateAuthority: false };
    }
}

/**
 * Analyze holder distribution
 */
async function analyzeHolderDistribution(
    mintAddress: string,
    connection: Connection,
    heliusKey?: string
): Promise<{ holderCount: number; deployerHoldings: number; top10Concentration: number }> {
    try {
        // 1. Get real holder stats (concentration, whales)
        const realStats = await getHolderStats(mintAddress, connection);

        // 2. Get real holder count (if possible)
        const realHolderCount = await getHolderCount(mintAddress, connection);

        // 3. Get pump data for bonding curve progress
        const pumpData = await getPumpData(mintAddress, connection);
        if (!pumpData) {
            return { holderCount: 0, deployerHoldings: 100, top10Concentration: 100 };
        }

        const bondingCurveProgress = Math.max(0, Math.min(100,
            100 - (((pumpData.vTokensInBondingCurve - 206900000) * 100) / 793100000)
        ));

        // 4. Determine Holder Count
        let holderCount = 0;

        if (realHolderCount !== null) {
            holderCount = realHolderCount;
        } else {
            // Fallback estimates
            holderCount = Math.floor(bondingCurveProgress * 20); // Base estimate

            // Refine estimate based on real top 10 data
            if (realStats) {
                // If top 10 hold very little (e.g. < 10%), implies many small holders
                if (realStats.top10Concentration < 10) {
                    holderCount = Math.max(holderCount, 200);
                }
                // If top 10 hold almost everything (> 90%), implies few holders
                if (realStats.top10Concentration > 90) {
                    holderCount = Math.min(holderCount, 20);
                }
            }
        }

        // 4. Determine Deployer Holdings
        // Ideally we need the deployer address. 
        // Without it, we look at the largest holder.
        // If the largest holder has > 20% and is not the bonding curve (filtered in getHolderStats),
        // it's a major red flag (likely deployer or sniper).
        let deployerHoldings = 0;
        if (realStats) {
            deployerHoldings = realStats.largestHolderPercentage;
        } else {
            // Fallback estimate
            const liquidityRatio = pumpData.vSolInBondingCurve / (bondingCurveProgress * 100);
            deployerHoldings = Math.min(50, Math.max(5, 50 - liquidityRatio * 10));
        }

        // 5. Determine Concentration
        let top10Concentration = 100;
        if (realStats) {
            top10Concentration = realStats.top10Concentration;
        } else {
            // Fallback estimate
            top10Concentration = holderCount > 500 ? 30 : holderCount > 200 ? 45 : 60;
        }

        return {
            holderCount,
            deployerHoldings,
            top10Concentration
        };
    } catch (e: any) {
        console.warn(`[analyzeHolderDistribution] Holder check failed for ${mintAddress.substring(0, 8)}: ${e.message}`);
        // Return neutral/conservative estimates if RPC fails, rather than deliberate "rug" values
        return {
            holderCount: 50, // Neutral estimate
            deployerHoldings: 15, // Conservative estimate
            top10Concentration: 70 // Conservative estimate
        };
    }
}

/**
 * Analyze volume metrics
 */
async function analyzeVolume(
    token: TokenData,
    age: number,
    liquidity: number,
    heliusKey?: string
): Promise<{ volume24h: number; buySellRatio: number }> {
    try {
        // Estimate volume based on liquidity growth
        const initialLiquidity = 30;
        const liquidityGrowth = liquidity - initialLiquidity;

        // Rough estimate: volume is typically 2-5x liquidity growth in early stages
        const estimatedVolume = Math.max(0, liquidityGrowth * 3);

        // Buy/sell ratio - estimate based on liquidity growth rate
        // Growing liquidity = more buys than sells
        const growthRate = age > 0 ? liquidityGrowth / age : 0;
        const buySellRatio = growthRate > 0.1 ? 0.7 : growthRate > 0.05 ? 0.6 : 0.5;

        return {
            volume24h: estimatedVolume,
            buySellRatio
        };
    } catch (e) {
        return { volume24h: 0, buySellRatio: 0.5 };
    }
}

function createRejectResult(
    reason: string,
    reasons: string[],
    warnings: string[],
    strengths: string[],
    bondingCurveProgress: number = 0,
    marketCap: number = 0,
    contractSecurity?: { freezeAuthority: boolean; mintAuthority: boolean; updateAuthority: boolean }
): EnhancedAnalysis {
    reasons.push(reason);
    return {
        score: 0,
        riskLevel: 'critical',
        passed: false,
        reasons,
        warnings,
        strengths,
        bondingCurveProgress,
        marketCap,
        metrics: {
            holderCount: 0,
            deployerHoldings: 100,
            top10Concentration: 100,
            volume24h: 0,
            buySellRatio: 0,
            bondingCurveVelocity: 0,
            liquidityDepth: 0,
            contractSecurity: contractSecurity || {
                freezeAuthority: false,
                mintAuthority: false,
                updateAuthority: false
            }
        }
    };
}
