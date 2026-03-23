export interface TokenData {
    mint: string;
    traderPublicKey: string;
    creatorPublicKey?: string;
    txType: "create" | "buy" | "sell";
    initialBuy: number;
    bondingCurveKey: string;
    vTokensInBondingCurve: number;
    vSolInBondingCurve: number;
    marketCapSol: number;
    name: string;
    symbol: string;
    uri: string;
    timestamp: number;
}
