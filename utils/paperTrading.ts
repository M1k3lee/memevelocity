export const PAPER_TRADE_FEE_RATE = 0.0175;
export const PAPER_TOKEN_ACCOUNT_RENT_SOL = 0.00204;

export function getPaperEntryPrice(observedPrice: number): number {
    if (!Number.isFinite(observedPrice) || observedPrice <= 0) {
        return 0;
    }

    return observedPrice * (1 + PAPER_TRADE_FEE_RATE);
}

export function getPaperExitPrice(observedPrice: number): number {
    if (!Number.isFinite(observedPrice) || observedPrice <= 0) {
        return 0;
    }

    return observedPrice * (1 - PAPER_TRADE_FEE_RATE);
}
