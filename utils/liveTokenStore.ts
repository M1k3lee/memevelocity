import type { TokenData } from '../types/token';

type StoredToken = {
    token: TokenData;
    updatedAt: number;
};

const latestTokens = new Map<string, StoredToken>();
const TOKEN_TTL_MS = 5 * 60 * 1000;

function pruneExpiredTokens(now: number) {
    for (const [mint, entry] of latestTokens.entries()) {
        if ((now - entry.updatedAt) > TOKEN_TTL_MS) {
            latestTokens.delete(mint);
        }
    }
}

export function recordLatestToken(token: TokenData): void {
    const now = Date.now();
    pruneExpiredTokens(now);
    latestTokens.set(token.mint, { token, updatedAt: now });
}

export function getLatestToken(mint: string): TokenData | null {
    const now = Date.now();
    pruneExpiredTokens(now);
    return latestTokens.get(mint)?.token || null;
}

export function clearLatestToken(mint: string): void {
    latestTokens.delete(mint);
}
