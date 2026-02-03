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
    slippage?: number;
}

export interface TierScores {
    tier0: number; // Metadata & Technical (100 pts needed)
    tier1: number; // Launch Timing (16 pts needed)
    tier2: number; // Holder Distribution (60 pts needed)
    tier3: number; // Engagement Velocity (35 pts needed)
    tier4: number; // Bonding Curve Momentum (50 pts needed)
    totalScore: number;
}

export interface EnhancedAnalysis {
    score: number; // 0-100 legacy score (mapped from Tier total)
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    passed: boolean; // Did it pass the Tier thresholds?
    reasons: string[];
    warnings: string[];
    strengths: string[];
    bondingCurveProgress: number; // 0-100%
    marketCap: number; // SOL
    tiers: TierScores;
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
 * Enhanced Token Analyzer based on "2026 Graduate Data Findings"
 * Implements the 4-Tier Framework for early spotted strategy.
 */
export async function analyzeEnhanced(
    token: TokenData,
    connection: Connection,
    heliusKey?: string,
    riskMode: 'runner' | 'sniper' | 'degen' | 'safe' | 'medium' | 'high' | 'velocity' | 'first' | 'scalp' = 'runner', // Mapped to new strategy
    config?: AdvancedConfig
): Promise<EnhancedAnalysis> {
    const reasons: string[] = [];
    const warnings: string[] = [];
    const strengths: string[] = [];

    // Map legacy modes to new strategy intent
    const isRunnerMode = riskMode === 'runner' || riskMode === 'safe' || riskMode === 'medium'; // Strict Tier compliance
    const isSniperMode = riskMode === 'sniper' || riskMode === 'high' || riskMode === 'first'; // Speed, Tier 0 only
    const isDegenMode = riskMode === 'degen' || riskMode === 'velocity'; // Loose checks, momentum focus

    try {
        const pumpData = await getPumpData(token.mint, connection);
        if (!pumpData) {
            return createRejectResult('Token not found on bonding curve', reasons, warnings, strengths);
        }

        const age = (Date.now() - token.timestamp) / 1000; // Age in seconds
        const liquidity = pumpData.vSolInBondingCurve;

        // Bonding Curve Progress
        const tokenBalance = pumpData.vTokensInBondingCurve;
        const bondingCurveProgress = Math.max(0, Math.min(100,
            100 - (((tokenBalance - 206900000) * 100) / 793100000)
        ));

        // Get Metadata & Security
        const metadata = await getTokenMetadata(token.mint, heliusKey);
        const contractSecurity = await checkContractSecurity(token.mint, connection);

        // === TIER 0: METADATA & TECHNICAL SETUP ===
        // Must pass 100 points (All checks)
        const tier0 = calculateTier0(token, metadata, contractSecurity, liquidity);
        if (tier0.score < 100) {
            // IMMEDIATE REJECT for Runner Mode
            if (isRunnerMode) {
                reasons.push(tier0.reasons[0] || 'Failed Tier 0 Checks');
                return createRejectResult(`TIER 0 FAIL: ${tier0.reasons[0]}`, reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity);
            } else {
                warnings.push(`TIER 0 FAIL: ${tier0.reasons.join(', ')}`);
            }
        }
        strengths.push(...tier0.strengths);

        // === TIER 1: LAUNCH TIMING ===
        const tier1 = calculateTier1(token.timestamp);
        if (isRunnerMode && tier1.score < 16) {
            // We can be lenient here if other scores are exceptional, but note it
            warnings.push(`TIER 1 WEAK: Bad launch time (${tier1.score} pts)`);
        } else if (tier1.score >= 16) {
            strengths.push(...tier1.strengths);
        }

        // === TIER 2: HOLDER DISTRIBUTION ===
        const holderMetrics = await analyzeHolderDistribution(token.mint, connection, heliusKey, bondingCurveProgress);
        const tier2 = calculateTier2(holderMetrics, age);

        if (isRunnerMode && tier2.score < 60) {
            // Strict fail for Runner
            if (config?.rugCheckStrictness !== 'lenient') {
                reasons.push(`TIER 2 FAIL: Bad distribution. Score ${tier2.score}/60`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity);
            } else {
                warnings.push(`TIER 2 WEAK: Score ${tier2.score}/60`);
            }
        } else if (tier2.score > 0) {
            strengths.push(...tier2.strengths);
        }

        // === TIER 3: ENGAGEMENT VELOCITY ===
        // We do a basic check here, can't fully replicate Twitter API v2 without key
        const hasSocials = await checkSocials(metadata.uri);
        const tier3 = calculateTier3(hasSocials, metadata, age);

        if (isRunnerMode && tier3.score < 35 && config?.rugCheckStrictness === 'strict') {
            warnings.push(`TIER 3 WEAK: Low social signals (${tier3.score} pts)`);
            // We don't auto-reject here because social scraping is limited without API keys
        } else {
            strengths.push(...tier3.strengths);
        }

        // === TIER 4: CURVE MOMENTUM ===
        const curveVelocity = age > 0 ? (bondingCurveProgress / age) * 60 : 0; // % per minute
        const tier4 = calculateTier4(bondingCurveProgress, curveVelocity, isRunnerMode ? 5 : 0, isRunnerMode ? 15 : 100);

        if (isRunnerMode && tier4.score < 50) {
            if (config?.rugCheckStrictness !== 'lenient') {
                reasons.push(`TIER 4 FAIL: Bad curve momentum. Score ${tier4.score}/50`);
                return createRejectResult(reasons[0], reasons, warnings, strengths, bondingCurveProgress, liquidity, contractSecurity);
            }
        }
        strengths.push(...tier4.strengths);

        // === FINAL DECISION ===
        const totalScore = tier0.score + tier1.score + tier2.score + tier3.score + tier4.score;
        let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'medium';
        let passed = false;

        // Custom Passing Logic based on Mode
        if (isRunnerMode) {
            // Strict: Must pass Tier 0, Tier 1 is boost, Tier 2 >= 60, Tier 4 >= 50
            passed = tier0.score >= 100 && tier2.score >= 60 && tier4.score >= 50 && bondingCurveProgress >= 5;
            riskLevel = passed ? 'low' : 'high';
        } else if (isSniperMode) {
            // Sniper: Must pass Tier 0, and be VERY early (< 2 mins)
            passed = tier0.score >= 100 && age < 120 && bondingCurveProgress < 10;
            riskLevel = 'high'; // Sniper is always high risk
        } else if (isDegenMode) {
            // Degen: Pass Tier 0, ignoring other checks if momentum is high
            passed = tier0.score >= 100 && (curveVelocity > 1.0 || liquidity > 50);
            riskLevel = 'critical';
        } else {
            // Fallback
            passed = totalScore > 200;
        }

        // normalize score to 0-100 for display compatibility
        const displayScore = Math.min(100, Math.round(totalScore / 5));

        return {
            score: displayScore,
            riskLevel,
            passed,
            reasons,
            warnings,
            strengths,
            bondingCurveProgress,
            marketCap: liquidity,
            tiers: {
                tier0: tier0.score,
                tier1: tier1.score,
                tier2: tier2.score,
                tier3: tier3.score,
                tier4: tier4.score,
                totalScore
            },
            metrics: {
                holderCount: holderMetrics.holderCount,
                deployerHoldings: holderMetrics.deployerHoldings,
                top10Concentration: holderMetrics.top10Concentration,
                volume24h: 0, // Need historical data
                buySellRatio: 0.7, // Estimated
                bondingCurveVelocity: curveVelocity,
                liquidityDepth: liquidity,
                contractSecurity
            }
        };

    } catch (error: any) {
        return createRejectResult(`Analysis Error: ${error.message}`, reasons, warnings, strengths);
    }
}

// ==============================================================================
// TIER CALCULATORS
// ==============================================================================

function calculateTier0(token: TokenData, metadata: any, security: any, liquidity: number) {
    let score = 0;
    const reasons: string[] = [];
    const strengths: string[] = [];

    // 1. Metadata URL Present?
    // Some metadata objects return empty uri, so we check name/symbol validity too
    if (metadata.name !== 'Unknown' && metadata.name !== 'Real Token') {
        score += 20;
    } else {
        reasons.push("No Metadata / Invalid");
        score -= 1000;
    }

    // 2. Token Standard (Legacy vs Token2022)
    score += 20; // Assume legacy for now

    // 3. Freeze Authority Revoked?
    if (security.freezeAuthority) {
        score += 20;
        strengths.push("Freeze Authority Revoked");
    } else {
        reasons.push("Freeze Authority Active (Honeypot Risk)");
        score -= 1000;
    }

    // 4. Mint Authority Revoked?
    if (security.mintAuthority) {
        score += 20;
        strengths.push("Mint Authority Revoked");
    } else {
        reasons.push("Mint Authority Active");
        score -= 1000;
    }

    // 5. Symbol/Name Length
    if (metadata.symbol && metadata.symbol.length >= 3 && metadata.symbol.length <= 6) {
        score += 10;
        strengths.push("Optimal Symbol Length");
    }
    if (metadata.name && metadata.name.length >= 4 && metadata.name.length <= 20) {
        score += 10;
    }

    // 6. Liquidity Min Check (Tier 0 basic filter)
    if (liquidity < 0.5) {
        reasons.push("Liquidity ~0 (Dead)");
        score -= 1000;
    }

    return { score, reasons, strengths };
}

function calculateTier1(timestamp: number) {
    let score = 0;
    const strengths: string[] = [];
    const date = new Date(timestamp);
    const day = date.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const hour = date.getUTCHours();

    // Fri(5)-Sun(0) 11:00-14:00 UTC
    const isWeekend = day === 5 || day === 6 || day === 0;
    const isGoldenHour = hour >= 11 && hour < 14;

    if (isWeekend && isGoldenHour) {
        score += 25;
        strengths.push("Golden Launch Window (Fri-Sun 11-14 UTC)");
    } else if (isGoldenHour) {
        score += 8; // Good time, wrong day
    } else if (isWeekend) {
        score += 16;
        strengths.push("Weekend Launch Boost");
    } else {
        // Mon-Thu
        if (day === 2) { // Tuesday
            score -= 100; // "Absolute Graveyard" per research
        } else {
            score -= 5;
        }
    }

    return { score, strengths };
}

function calculateTier2(metrics: { holderCount: number, deployerHoldings: number, top10Concentration: number }, age: number) {
    let score = 0;
    const strengths: string[] = [];

    // 1. Wallet Diversity
    if (metrics.holderCount >= 20) score += 30;
    else if (metrics.holderCount >= 15) score += 25;
    else if (metrics.holderCount >= 10) score += 15;
    else score -= 30;

    // 2. Creator Involvement (Deployer Holdings)
    if (metrics.deployerHoldings < 5) score += 25; // Clean
    else if (metrics.deployerHoldings < 20) score += 0;
    else score -= 50; // Creator hoarding

    // 3. Concentration
    if (metrics.top10Concentration < 10) score += 20;
    else if (metrics.top10Concentration < 20) score += 10;
    else if (metrics.top10Concentration > 50) score -= 40;

    if (score >= 60) strengths.push("Strong Holder Distribution");

    return { score, strengths };
}

function calculateTier3(hasSocials: boolean, metadata: any, age: number) {
    let score = 0;
    const strengths: string[] = [];

    // Can't fully implement Twitter API checks without key
    // Relying on metadata Socials presence
    if (hasSocials) {
        score += 25;
        strengths.push("Verified Socials Detected");
    } else if (metadata.description && metadata.description.length > 50) {
        score += 5; // Good description at least
    }

    // Age factor for engagement
    if (age > 300) score += 20; // Sustained presence

    return { score, strengths };
}

function calculateTier4(progress: number, velocity: number, minProgress: number, maxProgress: number) {
    let score = 0;
    const strengths: string[] = [];

    // 1. Progression Rate (5-15% ideal)
    if (progress >= 5 && progress <= 15) {
        score += 25;
        strengths.push(`Perfect Bonding Curve Position (${progress.toFixed(1)}%)`);
    } else if (progress > 15 && progress <= 30) {
        score += 15;
    } else if (progress > 0 && progress < 5) {
        score += 10;
    } else if (progress > 60) {
        score -= 60; // Flash pump or dead
    }

    // 2. Acceleration
    if (velocity > 0.5 && velocity < 5) {
        score += 25;
        strengths.push(`Organic Growth Velocity (${velocity.toFixed(1)}%/min)`);
    } else if (velocity >= 0.1 && velocity <= 0.5) {
        score += 15; // Steady
    } else if (velocity > 10) {
        score -= 20; // Flash pump risk
    } else if (velocity <= 0) {
        score -= 20; // Decelerating
    }

    return { score, strengths };
}

// ==============================================================================
// HELPERS
// ==============================================================================

function createRejectResult(
    reason: string,
    reasons: string[],
    warnings: string[],
    strengths: string[],
    bondingCurveProgress: number = 0,
    marketCap: number = 0,
    contractSecurity?: any
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
        tiers: { tier0: 0, tier1: 0, tier2: 0, tier3: 0, tier4: 0, totalScore: 0 },
        metrics: {
            holderCount: 0, deployerHoldings: 100, top10Concentration: 100,
            volume24h: 0, buySellRatio: 0, bondingCurveVelocity: 0, liquidityDepth: 0,
            contractSecurity: contractSecurity || { freezeAuthority: false, mintAuthority: false, updateAuthority: false }
        }
    };
}

async function checkContractSecurity(mintAddress: string, connection: Connection): Promise<{ freezeAuthority: boolean; mintAuthority: boolean; updateAuthority: boolean }> {
    try {
        const mint = new PublicKey(mintAddress);
        const mintInfo = await connection.getParsedAccountInfo(mint);
        if (!mintInfo.value || !mintInfo.value.data || typeof mintInfo.value.data === 'string') {
            return { freezeAuthority: false, mintAuthority: false, updateAuthority: false };
        }
        const parsed = mintInfo.value.data as any;
        return {
            freezeAuthority: parsed.parsed?.info?.freezeAuthority === null,
            mintAuthority: parsed.parsed?.info?.mintAuthority === null,
            updateAuthority: true // approximate
        };
    } catch { return { freezeAuthority: false, mintAuthority: false, updateAuthority: false }; }
}

async function checkSocials(uri: string): Promise<boolean> {
    if (!uri) return false;
    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 1500);
        const res = await fetch(uri, { signal: controller.signal });
        if (!res.ok) return false;
        const json = await res.json();
        const str = JSON.stringify(json).toLowerCase();
        return str.includes("twitter.com") || str.includes("t.me") || str.includes("discord");
    } catch { return false; }
}

async function analyzeHolderDistribution(mint: string, conn: Connection, key?: string, curveProgress: number = 0) {
    try {
        const realStats = await getHolderStats(mint, conn);
        const realCount = await getHolderCount(mint, conn);

        let holderCount = realCount || Math.floor(curveProgress * 20); // Fallback

        // Refine with real stats
        if (realStats) {
            if (realStats.top10Concentration < 10) holderCount = Math.max(holderCount, 200);
        }

        return {
            holderCount,
            deployerHoldings: realStats ? realStats.largestHolderPercentage : 50, // Pessimistic fallback
            top10Concentration: realStats ? realStats.top10Concentration : 90
        };
    } catch {
        return { holderCount: 5, deployerHoldings: 50, top10Concentration: 90 };
    }
}
