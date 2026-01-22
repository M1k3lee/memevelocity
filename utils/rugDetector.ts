import { TokenData } from '../components/LiveFeed';

/**
 * Advanced Rug Detection System
 * Detects common scam patterns including duplicate names, suspicious patterns, etc.
 */

// Track recently seen token names to detect copycat scams
const recentTokenNames = new Map<string, { timestamp: number, mint: string }>(); // name -> {timestamp, mint}
const NAME_COOLDOWN = 5 * 60 * 1000; // 5 minutes

// Suspicious name patterns that indicate scams
// These are common scam token names that scammers use
const SUSPICIOUS_PATTERNS = [
    /^real$/i,           // "real" - common copycat name
    /^test$/i,           // "test" - test tokens
    /^token$/i,          // Generic "token"
    /^coin$/i,           // Generic "coin"
    /^new$/i,            // "new" - copycat indicator
    /^copy$/i,           // "copy" - explicit copycat
    /^fake$/i,           // "fake" - obvious scam
    /^scam$/i,           // "scam" - obvious scam
    /^rug$/i,            // "rug" - obvious scam
    /^honeypot$/i,       // "honeypot" - obvious scam
    /^pump$/i,           // "pump" - pump and dump
    /^dump$/i,           // "dump" - dump token
    /^official$/i,       // "official" - copycat indicator
    /^verified$/i,       // "verified" - copycat indicator
    /^legit$/i,          // "legit" - suspicious claim
    /^100x$/i,           // "100x" - unrealistic promise
    /^1000x$/i,          // "1000x" - unrealistic promise
    /^safe$/i,           // "safe" - copycat indicator
    /^trust$/i,          // "trust" - copycat indicator
];

// Clean up old entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [name, data] of recentTokenNames.entries()) {
        if (now - data.timestamp > NAME_COOLDOWN) {
            recentTokenNames.delete(name);
        }
    }
}, 60000); // Clean every minute

export interface RugDetectionResult {
    isRug: boolean;
    reason?: string;
    confidence: number; // 0-100, higher = more confident it's a rug
    warnings: string[];
}

/**
 * Comprehensive rug detection
 */
export function detectRug(
    token: TokenData,
    riskMode: 'safe' | 'medium' | 'high' = 'medium'
): RugDetectionResult {
    const warnings: string[] = [];
    let confidence = 0;
    let isRug = false;
    let reason: string | undefined;

    const name = token.symbol?.toLowerCase().trim() || '';
    const age = (Date.now() - token.timestamp) / 1000; // Age in seconds
    const liquidity = token.vSolInBondingCurve || 30;
    const liquidityGrowth = liquidity - 30; // Initial liquidity is 30 SOL

    // === CRITICAL: Duplicate Name Detection (Copycat Scam) ===
    // This is the main issue - scammers copy successful token names
    if (name) {
        const normalizedName = name.toLowerCase().trim();
        const lastSeen = recentTokenNames.get(normalizedName);
        if (lastSeen && lastSeen.mint !== token.mint) {
            const timeSinceLastSeen = Date.now() - lastSeen.timestamp;
            // If we've seen this name recently (within cooldown), it's likely a copycat
            if (timeSinceLastSeen < NAME_COOLDOWN) {
                // In high-risk mode, be more lenient
                if (riskMode === 'high') {
                    // Only reject if seen very recently (within 60s)
                    if (timeSinceLastSeen < 60 * 1000) {
                        isRug = true;
                        confidence = 95;
                        reason = `🚨 COPYCAT SCAM: Symbol "${token.symbol}" match found (${(timeSinceLastSeen / 1000).toFixed(0)}s ago)`;
                    } else {
                        warnings.push(`⚠️ Duplicate symbol: "${token.symbol}" seen ${(timeSinceLastSeen / 1000).toFixed(0)}s ago`);
                        confidence = 40;
                    }
                } else {
                    isRug = true;
                    confidence = 95;
                    reason = `🚨 COPYCAT SCAM: Symbol "${token.symbol}" match found (${(timeSinceLastSeen / 1000).toFixed(0)}s ago)`;
                }
            }
        }

        // Record this name + mint for future detection
        recentTokenNames.set(normalizedName, { timestamp: Date.now(), mint: token.mint });
    }

    // === Suspicious Name Patterns ===
    if (name && !isRug) {
        for (const pattern of SUSPICIOUS_PATTERNS) {
            if (pattern.test(name)) {
                if (riskMode === 'high') {
                    warnings.push(`⚠️ Suspicious name pattern: "${token.symbol}" matches known scam pattern`);
                    confidence = Math.max(confidence, 50);
                } else {
                    isRug = true;
                    confidence = 90;
                    reason = `🚨 SUSPICIOUS NAME: "${token.symbol}" matches known scam pattern`;
                    break;
                }
            }
        }
    }

    // === Age + Liquidity Check (Very new tokens with low liquidity = rug) ===
    // FIX: Allow tokens a few seconds to 'breathe' before demanding liquidity growth
    if (!isRug && age < 120) {
        // 5s Grace period: Don't call it a rug just for being 0.1s old with 0 growth
        if (age > 5 && liquidityGrowth < 0.1) {
            if (riskMode === 'high') {
                warnings.push(`⚠️ Very new token (${age.toFixed(0)}s) with no liquidity growth`);
                confidence = Math.max(confidence, 40);
            } else {
                isRug = true;
                confidence = 85;
                reason = `🚨 TOO NEW + NO GROWTH: Token is ${age.toFixed(0)}s old with 0 growth - likely dead on arrival`;
            }
        }
        // Between 30s and 2m, we expect at least SOME growth
        else if (age > 30 && liquidityGrowth < 0.5) {
            if (riskMode !== 'high') {
                isRug = true;
                confidence = 85;
                reason = `🚨 STAGNANT: Token is ${age.toFixed(0)}s old with only ${liquidityGrowth.toFixed(2)} SOL growth - likely rug or low interest`;
            }
        }
    }

    // === Negative Liquidity Growth (Already crashed) ===
    if (!isRug && liquidityGrowth < -2) {
        isRug = true;
        confidence = 100;
        reason = `🚨 ALREADY CRASHED: Liquidity dropped ${Math.abs(liquidityGrowth).toFixed(2)} SOL - token already rugged`;
    }

    // === Extremely Low Liquidity (Honeypot) ===
    if (!isRug && liquidity < 1) {
        isRug = true;
        confidence = 100;
        reason = `🚨 HONEYPOT RISK: Liquidity is ${liquidity.toFixed(2)} SOL (below 1 SOL threshold)`;
    }

    // === Name Quality Checks ===
    if (!isRug && name) {
        // Very short names (1-2 chars) are often scams
        if (name.length <= 2 && riskMode !== 'high') {
            warnings.push(`⚠️ Very short name: "${token.symbol}" (${name.length} chars) - may be scam`);
            confidence = Math.max(confidence, 30);
        }

        // Names with only numbers are suspicious
        if (/^\d+$/.test(name) && riskMode !== 'high') {
            warnings.push(`⚠️ Name is only numbers: "${token.symbol}" - suspicious`);
            confidence = Math.max(confidence, 40);
        }

        // Names with excessive special characters
        const specialCharRatio = (name.match(/[^a-z0-9]/g) || []).length / name.length;
        if (specialCharRatio > 0.5 && name.length > 3) {
            warnings.push(`⚠️ Excessive special characters in name: "${token.symbol}"`);
            confidence = Math.max(confidence, 35);
        }
    }

    return {
        isRug,
        reason,
        confidence,
        warnings
    };
}

/**
 * Quick pre-filter before expensive analysis
 */
export function quickRugCheck(token: TokenData): { passed: boolean; reason?: string } {
    const detection = detectRug(token, 'medium'); // Use medium for quick check

    if (detection.isRug) {
        return { passed: false, reason: detection.reason };
    }

    return { passed: true };
}

/**
 * Clear the name tracking cache (useful for testing or reset)
 */
export function clearNameCache(): void {
    recentTokenNames.clear();
}

/**
 * Get statistics about detected rugs
 */
export function getRugStats(): { totalNamesTracked: number; recentNames: string[] } {
    const now = Date.now();
    const recentNames: string[] = [];

    for (const [name, data] of recentTokenNames.entries()) {
        if (now - data.timestamp < NAME_COOLDOWN) {
            recentNames.push(name);
        }
    }

    return {
        totalNamesTracked: recentTokenNames.size,
        recentNames: recentNames.slice(0, 20) // Last 20
    };
}

