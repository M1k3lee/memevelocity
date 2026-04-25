import type { TokenData } from '../types/token';
import { getTokenIdentityKey, sanitizeTokenIdentity } from './tokenIdentity';
import { getTokenAgeSeconds } from './tokenTiming';

/**
 * Advanced Rug Detection System
 * Detects common scam patterns including duplicate names, suspicious patterns, etc.
 */

const recentTokenNames = new Map<string, { timestamp: number; mint: string }>();
const quarantinedIdentities = new Map<string, { timestamp: number; mint: string; reason: string }>();
const recentMetadataUris = new Map<string, { timestamp: number; mint: string }>();
export type CreatorStats = {
    launches: number;
    suspiciousLaunches: number;
    // Positive-signal tracking (Phase 9): closed positions from this creator.
    // Outcomes are only counted on materially profitable / materially losing
    // closes — dust breakevens are ignored so small-sample noise doesn't
    // swing the reputation score.
    positiveOutcomes: number;
    negativeOutcomes: number;
    totalPnlSol: number;
    firstSeen: number;
    lastSeen: number;
};
const creatorReputation = new Map<string, CreatorStats>();
const NAME_COOLDOWN = 20 * 60 * 1000; // 20 min — scammers often wait out a 5-min window
const METADATA_URI_COOLDOWN = 30 * 60 * 1000; // 30 min — metadata re-use is a strong copycat signal
// Keep reputation around longer than the anti-copycat caches — a trusted
// creator is a compounding asset, we don't want it disappearing after 24h.
// We still garbage-collect stale entries so the map doesn't grow unbounded.
const CREATOR_REPUTATION_WINDOW = 7 * 24 * 60 * 60 * 1000; // 7d
// A realized PnL magnitude below this in absolute terms is treated as a
// rounding breakeven and does not count toward reputation outcomes.
const CREATOR_OUTCOME_DUST_SOL = 0.0003;

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
    for (const [name, data] of quarantinedIdentities.entries()) {
        if (now - data.timestamp > NAME_COOLDOWN) {
            quarantinedIdentities.delete(name);
        }
    }
    for (const [uri, data] of recentMetadataUris.entries()) {
        if (now - data.timestamp > METADATA_URI_COOLDOWN) {
            recentMetadataUris.delete(uri);
        }
    }
    for (const [creator, stats] of creatorReputation.entries()) {
        if (now - stats.lastSeen > CREATOR_REPUTATION_WINDOW) {
            creatorReputation.delete(creator);
        }
    }
}, 60000);

/**
 * Record that a creator is known to have launched at least one suspicious
 * token — copycat name, reused metadata, hard-rug signal, etc. Subsequent
 * launches from the same address will trigger a reputation warning.
 */
function emptyCreatorStats(now: number = Date.now()): CreatorStats {
    return {
        launches: 0,
        suspiciousLaunches: 0,
        positiveOutcomes: 0,
        negativeOutcomes: 0,
        totalPnlSol: 0,
        firstSeen: now,
        lastSeen: now
    };
}

export function markCreatorSuspicious(creator: string | null | undefined): void {
    if (!creator) return;
    const stats = creatorReputation.get(creator) || emptyCreatorStats();
    stats.suspiciousLaunches += 1;
    stats.lastSeen = Date.now();
    creatorReputation.set(creator, stats);
}

function recordCreatorLaunch(creator: string | null | undefined): CreatorStats | null {
    if (!creator) return null;
    const now = Date.now();
    const stats = creatorReputation.get(creator) || emptyCreatorStats(now);
    stats.launches += 1;
    stats.lastSeen = now;
    creatorReputation.set(creator, stats);
    return stats;
}

/**
 * Phase 9: Record the realized PnL outcome of a closed position for its
 * creator. This is how we build a positive reputation — a wallet that
 * keeps shipping tokens that close profitably accumulates a trusted
 * track record, and future launches from them get a relaxation bonus
 * in the entry analyzer.
 *
 * Only meaningful outcomes move the counters. Dust-level breakevens
 * (|pnl| < CREATOR_OUTCOME_DUST_SOL) are ignored to keep the signal
 * clean when compounding from a small starting balance.
 */
export function recordCreatorOutcome(creator: string | null | undefined, pnlSol: number): void {
    if (!creator || !Number.isFinite(pnlSol)) return;
    if (Math.abs(pnlSol) < CREATOR_OUTCOME_DUST_SOL) return;
    const now = Date.now();
    const stats = creatorReputation.get(creator) || emptyCreatorStats(now);
    if (pnlSol > 0) {
        stats.positiveOutcomes += 1;
    } else {
        stats.negativeOutcomes += 1;
    }
    stats.totalPnlSol += pnlSol;
    stats.lastSeen = now;
    creatorReputation.set(creator, stats);
}

/**
 * Phase 9: Derive a reputation summary we can use in entry scoring.
 * - score: (pos - neg) / (pos + neg), in [-1, 1]. Null if the sample is
 *   too small to trust (fewer than 2 outcomes).
 * - samples: total number of scoring outcomes observed.
 * - trusted: score >= 0.5 with 3+ samples (earns an entry bonus).
 * - avoid:   score <= -0.5 with 3+ samples or >=2 suspicious launches.
 */
export function getCreatorReputationScore(creator: string | null | undefined): {
    score: number;
    samples: number;
    totalPnlSol: number;
    trusted: boolean;
    avoid: boolean;
} | null {
    if (!creator) return null;
    const stats = creatorReputation.get(creator);
    if (!stats) return null;
    const samples = stats.positiveOutcomes + stats.negativeOutcomes;
    const avoidBySuspicion = stats.suspiciousLaunches >= 2;
    if (samples < 2 && !avoidBySuspicion) return null;
    const score = samples > 0 ? (stats.positiveOutcomes - stats.negativeOutcomes) / samples : 0;
    const trusted = samples >= 3 && score >= 0.5 && stats.totalPnlSol > 0 && !avoidBySuspicion;
    const avoid = avoidBySuspicion || (samples >= 3 && score <= -0.5);
    return { score, samples, totalPnlSol: stats.totalPnlSol, trusted, avoid };
}

/**
 * Export the full reputation map so the runner can persist it in
 * BotState and restore it on restart. Without persistence the whole
 * positive-reputation edge resets every time the bot restarts.
 */
export function exportCreatorReputation(): Record<string, CreatorStats> {
    const out: Record<string, CreatorStats> = {};
    for (const [creator, stats] of creatorReputation.entries()) {
        out[creator] = { ...stats };
    }
    return out;
}

export function importCreatorReputation(snapshot: Record<string, CreatorStats> | undefined | null): void {
    if (!snapshot) return;
    for (const [creator, stats] of Object.entries(snapshot)) {
        if (!creator || !stats) continue;
        creatorReputation.set(creator, {
            launches: Number(stats.launches) || 0,
            suspiciousLaunches: Number(stats.suspiciousLaunches) || 0,
            positiveOutcomes: Number(stats.positiveOutcomes) || 0,
            negativeOutcomes: Number(stats.negativeOutcomes) || 0,
            totalPnlSol: Number(stats.totalPnlSol) || 0,
            firstSeen: Number(stats.firstSeen) || Date.now(),
            lastSeen: Number(stats.lastSeen) || Date.now()
        });
    }
}

function quarantineIdentity(identityText: string, mint: string, reason: string) {
    if (!identityText) return;
    quarantinedIdentities.set(identityText, {
        timestamp: Date.now(),
        mint,
        reason
    });
}

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
    const age = getTokenAgeSeconds(token);
    const liquidity = token.vSolInBondingCurve || 30;
    const liquidityGrowth = liquidity - 30;
    const creator = token.creatorPublicKey || null;

    // Creator reputation check — if this creator has previously launched a
    // token that we flagged as suspicious, treat new launches from them as
    // rug candidates. Legitimate creators occasionally launch a second token,
    // but serial launches from the same wallet are overwhelmingly rugs.
    const creatorStats = recordCreatorLaunch(creator);
    if (creatorStats && creatorStats.suspiciousLaunches >= 1 && riskMode !== 'high') {
        isRug = true;
        confidence = 92;
        reason = `BAD CREATOR: ${creator!.slice(0, 8)}… has ${creatorStats.suspiciousLaunches} prior flagged launch${creatorStats.suspiciousLaunches === 1 ? '' : 'es'}`;
    } else if (creatorStats && creatorStats.launches >= 4 && (Date.now() - creatorStats.firstSeen) < 6 * 60 * 60 * 1000) {
        // Four+ launches in 6 hours from the same wallet — serial launcher.
        warnings.push(`Serial launcher: ${creatorStats.launches} launches in the last ${Math.round((Date.now() - creatorStats.firstSeen) / 3_600_000)}h`);
        confidence = Math.max(confidence, 55);
        if (riskMode !== 'high') {
            isRug = true;
            reason = `SERIAL LAUNCHER: ${creatorStats.launches} tokens from ${creator!.slice(0, 8)}… in the last few hours`;
        }
    }

    // Metadata-URI reuse — pump.fun scammers commonly reuse the same image/uri
    // from a rugged token to trick people who liked the previous art. If we've
    // seen this exact URI within the last 30 minutes from a different mint,
    // quarantine it.
    const uri = (token.uri || '').trim();
    if (!isRug && uri && uri.length > 12) {
        const lastUri = recentMetadataUris.get(uri);
        if (lastUri && lastUri.mint !== token.mint) {
            const age = Date.now() - lastUri.timestamp;
            if (age < METADATA_URI_COOLDOWN) {
                isRug = true;
                confidence = 94;
                reason = `COPYCAT ART: metadata URI reused from mint ${lastUri.mint.slice(0, 6)}… (${Math.round(age / 1000)}s ago)`;
                markCreatorSuspicious(creator);
            }
        }
        if (!isRug) {
            recentMetadataUris.set(uri, { timestamp: Date.now(), mint: token.mint });
        }
    }

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
                        quarantineIdentity(identityText, token.mint, reason);
                        markCreatorSuspicious(creator);
                    } else {
                        warnings.push(`Duplicate ${identityLabel.toLowerCase()}: "${displayIdentity}" seen ${(timeSinceLastSeen / 1000).toFixed(0)}s ago`);
                        confidence = 40;
                    }
                } else {
                    isRug = true;
                    confidence = 95;
                    reason = `COPYCAT SCAM: ${identityLabel} "${displayIdentity}" seen ${(timeSinceLastSeen / 1000).toFixed(0)}s ago`;
                    quarantineIdentity(identityText, token.mint, reason);
                    markCreatorSuspicious(creator);
                }
            }
        }

        if (!isRug || lastSeen?.mint === token.mint) {
            recentTokenNames.set(identityText, { timestamp: Date.now(), mint: token.mint });
        }
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
                quarantineIdentity(identityText, token.mint, reason);
                markCreatorSuspicious(creator);
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
    quarantinedIdentities.clear();
    recentMetadataUris.clear();
    creatorReputation.clear();
}

export function getCreatorReputation(creator: string | null | undefined): CreatorStats | null {
    if (!creator) return null;
    return creatorReputation.get(creator) || null;
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

export function getIdentityQuarantine(identityOrToken?: string | Pick<TokenData, 'symbol' | 'name'>): { reason: string; mint: string; ageMs: number } | null {
    const identity = typeof identityOrToken === 'string'
        ? sanitizeTokenIdentity(identityOrToken)
        : identityOrToken
            ? getTokenIdentityKey(identityOrToken)
            : '';

    if (!identity) return null;

    const entry = quarantinedIdentities.get(identity.toLowerCase());
    if (!entry) return null;

    const ageMs = Date.now() - entry.timestamp;
    if (ageMs > NAME_COOLDOWN) {
        quarantinedIdentities.delete(identity.toLowerCase());
        return null;
    }

    return {
        reason: entry.reason,
        mint: entry.mint,
        ageMs
    };
}
