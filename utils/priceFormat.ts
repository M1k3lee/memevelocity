export function formatTokenPrice(price: number): string {
    if (!Number.isFinite(price) || price <= 0) {
        return "0";
    }

    const absolutePrice = Math.abs(price);
    let decimals = 6;

    if (absolutePrice < 1) {
        const leadingZeroes = Math.max(0, -Math.floor(Math.log10(absolutePrice)) - 1);
        decimals = Math.min(14, Math.max(6, leadingZeroes + 4));
    }

    return price
        .toFixed(decimals)
        .replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, '$1');
}
