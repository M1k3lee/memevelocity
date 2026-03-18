import type { TokenData } from '../types/token';
import { getTokenIdentityKey, sanitizeTokenIdentity } from './tokenIdentity';

/**
 * Advanced Rug Detection System
 * Detects common scam patterns including duplicate names, suspicious patterns, etc.
 */

const recentTokenNames = new Map<string, { timestamp: number; mint: string }>();
const NAME_COOLDOWN = 5 * 60 * 1000;

const SUSPICIOUS_PATTERNS = [
    /^real$/i,
    /^test$/i,
    /^token$/i,
    /^coin$/i,
    /^new$/i,
    /^copy$/i,
    /^fake$/i,
    /^scam$/i,
    /^rug$/i,
    /^honeypot$/i,
    /^pump$/i,
    /^dump$/i,
    /^official$/i,
    /^verified$/i,
    /^legit$/i,
    /^100x$/i,
    /^1000x$/i,
    /^safe$/i,
    /^trust$/i
];

setInterval(() => {
    const now = Date.now();
    for (const [name, data] of recentTokenNames.entries()) {
        if (now - data.timestamp > NAME_COOLDOWN) {
            recentTokenNames.delete(name);
        }
    }
}, 60000);

export interface RugDetectionResult {
    isRug: boolean;
    reason?: string;
    confidence: number;
    warnings: string[];
}

export function detectRug(
    token: TokenData,
    riskMode: 'safe' | 'medium' | 'high' = 'medium'
): RugDetectionResult {
    const warnings: string[] = [];
    let confidence = 0;
    let isRug = false;
    let reason: string | undefined;

    const identity = getTokenIdentityKey(token);
    const identityText = identity.toLowerCase();
    const displayIdentity = sanitizeTokenIdentity(token.symbol) || sanitizeTokenIdentity(token.name) || 'metadata pending';
    const identityLabel = sanitizeTokenIdentity(token.symbol) ? 'Symbol' : 'Name';
    const age = (Date.now() - token.timestamp) / 1000;
    const liquidity = token.vSolInBondingCurve || 30;
    const liquidityGrowth = liquidity - 30;

    if (identityText) {
        const lastSeen = recentTokenNames.get(identityText);
        if (lastSeen && lastSeen.mint !== token.mint) {
            const timeSinceLastSeen = Date.now() - lastSeen.timestamp;
            if (timeSinceLastSeen < NAME_COOLDOWN) {
                if (riskMode === 'high') {
                    if (timeSinceLastSeen < 60 * 1000) {
                        isRug = true;
                        confidence = 95;
                        reason = `COPYCAT SCAM: ${identityLabel} "${displayIdentity}" seen ${(timeSinceLastSeen / 1000).toFixed(0)}s ago`;
                    } else {
                        warnings.push(`Duplicate ${identityLabel.toLowerCase()}: "${displayIdentity}" seen ${(timeSinceLastSeen / 1000).toFixed(0)}s ago`);
                        confidence = 40;
                    }
                } else {
                    isRug = true;
                    confidence = 95;
                    reason = `COPYCAT SCAM: ${identityLabel} "${displayIdentity}" seen ${(timeSinceLastSeen / 1000).toFixed(0)}s ago`;
                }
            }
        }

        recentTokenNames.set(identityText, { timestamp: Date.now(), mint: token.mint });
    }

    if (identityText && !isRug) {
        for (const pattern of SUSPICIOUS_PATTERNS) {
            if (!pattern.test(identityText)) continue;

            if (riskMode === 'high') {
                warnings.push(`Suspicious ${identityLabel.toLowerCase()} pattern: "${displayIdentity}"`);
                confidence = Math.max(confidence, 50);
            } else {
                isRug = true;
                confidence = 90;
                reason = `SUSPICIOUS NAME: "${displayIdentity}" matches a known scam pattern`;
            }
            break;
        }
    }

    if (!isRug && age < 120) {
        if (age > 5 && liquidityGrowth < 0.1) {
            if (riskMode === 'high') {
                warnings.push(`Very new token (${age.toFixed(0)}s) with no liquidity growth`);
                confidence = Math.max(confidence, 40);
            } else {
                isRug = true;
                confidence = 85;
                reason = `TOO NEW + NO GROWTH: ${age.toFixed(0)}s old with no liquidity growth`;
            }
        } else if (age > 30 && liquidityGrowth < 0.5 && riskMode !== 'high') {
            isRug = true;
            confidence = 85;
            reason = `STAGNANT: ${age.toFixed(0)}s old with only ${liquidityGrowth.toFixed(2)} SOL growth`;
        }
    }

    if (!isRug && liquidityGrowth < -2) {
        isRug = true;
        confidence = 100;
        reason = `ALREADY CRASHED: liquidity dropped ${Math.abs(liquidityGrowth).toFixed(2)} SOL`;
    }

    if (!isRug && liquidity < 1) {
        isRug = true;
        confidence = 100;
        reason = `HONEYPOT RISK: liquidity is ${liquidity.toFixed(2)} SOL`;
    }

    if (!isRug && identityText) {
        if (identityText.length <= 2 && riskMode !== 'high') {
            warnings.push(`Very short name: "${displayIdentity}" (${identityText.length} chars)`);
            confidence = Math.max(confidence, 30);
        }

        if (/^\d+$/.test(identityText) && riskMode !== 'high') {
            warnings.push(`Name is only numbers: "${displayIdentity}"`);
            confidence = Math.max(confidence, 40);
        }

        const specialCharRatio = (identityText.match(/[^a-z0-9]/g) || []).length / identityText.length;
        if (specialCharRatio > 0.5 && identityText.length > 3) {
            warnings.push(`Excessive special characters in name: "${displayIdentity}"`);
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

export function quickRugCheck(token: TokenData): { passed: boolean; reason?: string } {
    const detection = detectRug(token, 'medium');

    if (detection.isRug) {
        return { passed: false, reason: detection.reason };
    }

    return { passed: true };
}

export function clearNameCache(): void {
    recentTokenNames.clear();
}

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
        recentNames: recentNames.slice(0, 20)
    };
}
