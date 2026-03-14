import type { TokenData } from '../types/token';

function normalizeSol(value?: number): number {
    if (!value || Number.isNaN(value)) return 0;
    return value > 1_000_000 ? value / 1_000_000_000 : value;
}

export function normalizeTokenEvent(data: any, receivedAt: number = Date.now()): TokenData {
    return {
        mint: data.mint,
        traderPublicKey: data.traderPublicKey || "",
        txType: data.txType || "buy",
        initialBuy: normalizeSol(data.initialBuy),
        bondingCurveKey: data.bondingCurveKey || "",
        vTokensInBondingCurve: data.vTokensInBondingCurve || 0,
        vSolInBondingCurve: normalizeSol(data.vSolInBondingCurve),
        marketCapSol: normalizeSol(data.marketCapSol) || normalizeSol(data.vSolInBondingCurve),
        name: data.name || "",
        symbol: data.symbol || "???",
        uri: data.uri || "",
        timestamp: receivedAt
    };
}

export function mergeTokenData(existing: TokenData | undefined, token: TokenData): TokenData {
    return {
        ...existing,
        ...token,
        name: token.name || existing?.name || "Unknown",
        symbol: token.symbol || existing?.symbol || "???",
        uri: token.uri || existing?.uri || "",
        timestamp: existing?.timestamp || token.timestamp
    };
}
