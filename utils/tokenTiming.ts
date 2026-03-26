import type { TokenData } from '../types/token';

type TokenTiming = Pick<TokenData, 'timestamp' | 'createdAt' | 'lastSeenAt'>;

export function getTokenLaunchTimestamp(token: TokenTiming): number {
    return token.createdAt || token.timestamp || token.lastSeenAt || Date.now();
}

export function getTokenLastSeenTimestamp(token: TokenTiming): number {
    return token.lastSeenAt || token.timestamp || token.createdAt || Date.now();
}

export function getTokenAgeSeconds(token: TokenTiming, now: number = Date.now()): number {
    return Math.max(0, (now - getTokenLaunchTimestamp(token)) / 1000);
}

export function getTokenAgeMs(token: TokenTiming, now: number = Date.now()): number {
    return Math.max(0, now - getTokenLaunchTimestamp(token));
}
