import type { TokenData } from '../types/token';

const PLACEHOLDER_VALUES = new Set([
    'unknown',
    'n/a',
    'na',
    'null',
    'undefined',
    'pending'
]);

export function sanitizeTokenIdentity(value?: string): string {
    const normalized = (value || '').replace(/\0/g, '').trim();
    if (!normalized) return '';
    if (/^\?+$/.test(normalized)) return '';
    if (PLACEHOLDER_VALUES.has(normalized.toLowerCase())) return '';
    return normalized;
}

export function hasUsableTokenIdentity(value?: string): boolean {
    return sanitizeTokenIdentity(value) !== '';
}

export function getTokenIdentityKey(token: Pick<TokenData, 'symbol' | 'name'>): string {
    return sanitizeTokenIdentity(token.symbol) || sanitizeTokenIdentity(token.name);
}

function shortenMint(mint?: string): string {
    const normalized = (mint || '').trim();
    if (!normalized) return 'Pending';
    if (normalized.length <= 10) return normalized;
    return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

export function getTokenDisplaySymbol(token: Pick<TokenData, 'symbol' | 'mint'>): string {
    return sanitizeTokenIdentity(token.symbol) || shortenMint(token.mint);
}

export function getTokenDisplayName(token: Pick<TokenData, 'name' | 'symbol'>): string {
    return sanitizeTokenIdentity(token.name) || sanitizeTokenIdentity(token.symbol) || 'Metadata pending';
}
