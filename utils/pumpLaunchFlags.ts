import type { TokenData } from '../types/token';

type PumpLaunchTag = 'mayhem' | 'cashback' | 'creator-fee' | 'rewards' | 'cto';

export interface PumpLaunchFlags {
    tags: PumpLaunchTag[];
    hardBlock: boolean;
    incentiveMode: boolean;
    cautionScore: number;
    summary: string[];
}

function normalizeText(value: unknown): string {
    return typeof value === 'string' ? value.toLowerCase() : '';
}

function collectSearchText(token: Pick<TokenData, 'name' | 'symbol' | 'uri'>, metadata?: any): string {
    const attributeText = Array.isArray(metadata?.attributes)
        ? metadata.attributes
            .map((attribute: any) => `${normalizeText(attribute?.trait_type)} ${normalizeText(attribute?.value)}`)
            .join(' ')
        : '';

    return [
        normalizeText(token.name),
        normalizeText(token.symbol),
        normalizeText(token.uri),
        normalizeText(metadata?.name),
        normalizeText(metadata?.symbol),
        normalizeText(metadata?.description),
        normalizeText(metadata?.external_url),
        normalizeText(metadata?.website),
        normalizeText(metadata?.twitter),
        normalizeText(metadata?.telegram),
        attributeText
    ]
        .filter(Boolean)
        .join(' ');
}

function hasAnyKeyword(text: string, keywords: string[]): boolean {
    return keywords.some((keyword) => text.includes(keyword));
}

export function detectPumpLaunchFlags(token: Pick<TokenData, 'name' | 'symbol' | 'uri' | 'isMayhemMode'>, metadata?: any): PumpLaunchFlags {
    const text = collectSearchText(token, metadata);
    const tags: PumpLaunchTag[] = [];
    const summary: string[] = [];

    const mayhemDetected = !!token.isMayhemMode || hasAnyKeyword(text, ['mayhem mode', 'mayhem', 'chaos mode']);
    const cashbackDetected = hasAnyKeyword(text, ['cashback coin', 'cashback', 'rebate', 'fee back']);
    const creatorFeeDetected = hasAnyKeyword(text, ['creator fee', 'fee owner', 'fee share']);
    const rewardsDetected = hasAnyKeyword(text, ['rewards', 'revshare', 'revenue share', 'yield', 'apy']);
    const ctoDetected = hasAnyKeyword(text, ['community takeover', 'cto', 'takeover']);

    if (mayhemDetected) {
        tags.push('mayhem');
        summary.push('Mayhem-style launch language detected');
    }

    if (cashbackDetected) {
        tags.push('cashback');
        summary.push('Cashback / rebate language detected');
    }

    if (creatorFeeDetected) {
        tags.push('creator-fee');
        summary.push('Creator-fee language detected');
    }

    if (rewardsDetected) {
        tags.push('rewards');
        summary.push('Reward / revenue-share language detected');
    }

    if (ctoDetected) {
        tags.push('cto');
        summary.push('CTO / takeover language detected');
    }

    const incentiveMode = cashbackDetected || creatorFeeDetected || rewardsDetected;
    const hardBlock = mayhemDetected;
    let cautionScore = 0;

    if (hardBlock) cautionScore += 18;
    if (incentiveMode) cautionScore += 8;
    if (ctoDetected) cautionScore += 4;

    return {
        tags,
        hardBlock,
        incentiveMode,
        cautionScore,
        summary
    };
}

export function createEmptyPumpLaunchFlags(): PumpLaunchFlags {
    return {
        tags: [],
        hardBlock: false,
        incentiveMode: false,
        cautionScore: 0,
        summary: []
    };
}
