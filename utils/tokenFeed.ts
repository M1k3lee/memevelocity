import type { TokenData } from '../types/token';
import { sanitizeTokenIdentity } from './tokenIdentity';

function normalizeNumber(value?: unknown): number {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : 0;
}

function normalizeSol(value?: number): number {
    const normalized = normalizeNumber(value);
    if (!normalized) return 0;
    return normalized > 1_000_000 ? normalized / 1_000_000_000 : normalized;
}

export function normalizeTokenEvent(data: any, receivedAt: number = Date.now()): TokenData {
    const txType = data.txType || "buy";
    const traderPublicKey = data.traderPublicKey || "";
    const creatorPublicKey = data.creatorPublicKey || data.creator || (txType === 'create' ? traderPublicKey : "");

    return {
        mint: data.mint,
        traderPublicKey,
        creatorPublicKey,
        txType,
        initialBuy: normalizeSol(data.initialBuy),
        bondingCurveKey: data.bondingCurveKey || "",
        vTokensInBondingCurve: normalizeNumber(data.vTokensInBondingCurve),
        vSolInBondingCurve: normalizeSol(data.vSolInBondingCurve),
        marketCapSol: normalizeSol(data.marketCapSol) || normalizeSol(data.vSolInBondingCurve),
        name: sanitizeTokenIdentity(data.name),
        symbol: sanitizeTokenIdentity(data.symbol),
        uri: data.uri || "",
        isMayhemMode: Boolean(data.is_mayhem_mode || data.isMayhemMode),
        timestamp: receivedAt,
        createdAt: txType === 'create' ? receivedAt : undefined,
        lastSeenAt: receivedAt
    };
}

export function mergeTokenData(existing: TokenData | undefined, token: TokenData): TokenData {
    const vTokensInBondingCurve = token.vTokensInBondingCurve > 0
        ? token.vTokensInBondingCurve
        : (existing?.vTokensInBondingCurve || 0);
    const vSolInBondingCurve = token.vSolInBondingCurve > 0
        ? token.vSolInBondingCurve
        : (existing?.vSolInBondingCurve || 0);
    const marketCapSol = token.marketCapSol > 0
        ? token.marketCapSol
        : (existing?.marketCapSol || vSolInBondingCurve);
    const createdAt = existing?.createdAt || existing?.timestamp || token.createdAt || token.timestamp;
    const lastSeenAt = token.lastSeenAt || token.timestamp || existing?.lastSeenAt || createdAt;

    return {
        ...existing,
        ...token,
        traderPublicKey: token.traderPublicKey || existing?.traderPublicKey || "",
        creatorPublicKey: token.creatorPublicKey || existing?.creatorPublicKey || (token.txType === 'create' ? token.traderPublicKey : ""),
        initialBuy: token.initialBuy > 0 ? token.initialBuy : (existing?.initialBuy || 0),
        bondingCurveKey: token.bondingCurveKey || existing?.bondingCurveKey || "",
        vTokensInBondingCurve,
        vSolInBondingCurve,
        marketCapSol,
        name: sanitizeTokenIdentity(token.name) || sanitizeTokenIdentity(existing?.name) || "",
        symbol: sanitizeTokenIdentity(token.symbol) || sanitizeTokenIdentity(existing?.symbol) || "",
        uri: token.uri || existing?.uri || "",
        isMayhemMode: token.isMayhemMode ?? existing?.isMayhemMode ?? false,
        timestamp: createdAt,
        createdAt,
        lastSeenAt
    };
}
