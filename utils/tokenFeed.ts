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
    return {
        mint: data.mint,
        traderPublicKey: data.traderPublicKey || "",
        txType: data.txType || "buy",
        initialBuy: normalizeSol(data.initialBuy),
        bondingCurveKey: data.bondingCurveKey || "",
        vTokensInBondingCurve: normalizeNumber(data.vTokensInBondingCurve),
        vSolInBondingCurve: normalizeSol(data.vSolInBondingCurve),
        marketCapSol: normalizeSol(data.marketCapSol) || normalizeSol(data.vSolInBondingCurve),
        name: sanitizeTokenIdentity(data.name),
        symbol: sanitizeTokenIdentity(data.symbol),
        uri: data.uri || "",
        timestamp: receivedAt
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

    return {
        ...existing,
        ...token,
        traderPublicKey: token.traderPublicKey || existing?.traderPublicKey || "",
        initialBuy: token.initialBuy > 0 ? token.initialBuy : (existing?.initialBuy || 0),
        bondingCurveKey: token.bondingCurveKey || existing?.bondingCurveKey || "",
        vTokensInBondingCurve,
        vSolInBondingCurve,
        marketCapSol,
        name: sanitizeTokenIdentity(token.name) || sanitizeTokenIdentity(existing?.name) || "",
        symbol: sanitizeTokenIdentity(token.symbol) || sanitizeTokenIdentity(existing?.symbol) || "",
        uri: token.uri || existing?.uri || "",
        timestamp: token.timestamp
    };
}
