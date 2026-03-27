export type InternalMode =
    | 'runner'
    | 'sniper'
    | 'degen'
    | 'god'
    | 'micro'
    | 'custom'
    | 'safe'
    | 'medium'
    | 'high'
    | 'velocity'
    | 'first'
    | 'scalp';

export type VisibleStrategyMode = 'god' | 'micro' | 'degen' | 'sniper' | 'custom';

export interface StrategyAdvancedConfig {
    minLiquidity: number;
    maxLiquidity: number;
    minVolume: number;
    minHolderCount: number;
    maxTop10: number;
    maxDev: number;
    minBondingCurve: number;
    maxBondingCurve: number;
    minVelocity: number;
    rugCheckStrictness: 'lenient' | 'standard' | 'strict';
    requireSocials: boolean;
    avoidSnipers: boolean;
    slippage: number;
}

export interface StrategyPresetConfig {
    mode: VisibleStrategyMode;
    amount: number;
    takeProfit: number;
    stopLoss: number;
    maxConcurrentTrades: number;
    dynamicSizing: boolean;
    advanced: StrategyAdvancedConfig;
}

export interface StrategyProfileDefinition {
    id: VisibleStrategyMode;
    label: string;
    subtitle: string;
    description: string;
}

export const STRATEGY_PROFILE_DEFINITIONS: StrategyProfileDefinition[] = [
    {
        id: 'god',
        label: 'Conservative',
        subtitle: 'Selective runner entries',
        description: 'Lower frequency, stronger confirmation, best default for live capital.'
    },
    {
        id: 'micro',
        label: 'Balanced',
        subtitle: 'Reclaim-first compounding',
        description: 'Waits for the first shakeout, then looks for a cleaner second leg.'
    },
    {
        id: 'degen',
        label: 'Aggressive',
        subtitle: 'Faster momentum entries',
        description: 'Picks up trades earlier with smaller size, but still keeps rug filters on.'
    },
    {
        id: 'sniper',
        label: 'Experimental',
        subtitle: 'Earliest entries, smallest size',
        description: 'Use for paper testing or tiny size only. Launch behavior is still the least reliable.'
    },
    {
        id: 'custom',
        label: 'Custom',
        subtitle: 'Manual control',
        description: 'Direct parameter control when you want to override the curated presets.'
    }
];

export function normalizeStrategyProfile(mode?: string): VisibleStrategyMode {
    if (!mode) {
        return 'god';
    }

    switch (mode) {
        case 'runner':
        case 'safe':
        case 'medium':
        case 'god':
            return 'god';
        case 'micro':
            return 'micro';
        case 'degen':
        case 'high':
        case 'velocity':
        case 'scalp':
            return 'degen';
        case 'sniper':
        case 'first':
            return 'sniper';
        default:
            return 'custom';
    }
}

export function getStrategyPresetConfig(profile: VisibleStrategyMode): StrategyPresetConfig {
    switch (profile) {
        case 'god':
            return {
                mode: 'god',
                amount: 0.008,
                takeProfit: 30,
                stopLoss: 5,
                maxConcurrentTrades: 1,
                dynamicSizing: true,
                advanced: {
                    minLiquidity: 34,
                    maxLiquidity: 120,
                    minVolume: 1.3,
                    minHolderCount: 12,
                    maxTop10: 24,
                    maxDev: 3,
                    minBondingCurve: 1.2,
                    maxBondingCurve: 14,
                    minVelocity: 0.7,
                    rugCheckStrictness: 'strict',
                    requireSocials: false,
                    avoidSnipers: true,
                    slippage: 14
                }
            };
        case 'micro':
            return {
                mode: 'micro',
                amount: 0.008,
                takeProfit: 12,
                stopLoss: 6,
                maxConcurrentTrades: 1,
                dynamicSizing: false,
                advanced: {
                    minLiquidity: 8,
                    maxLiquidity: 200,
                    minVolume: 1.0,
                    minHolderCount: 6,
                    maxTop10: 55,
                    maxDev: 12,
                    minBondingCurve: 1,
                    maxBondingCurve: 18,
                    minVelocity: 0.3,
                    rugCheckStrictness: 'standard',
                    requireSocials: false,
                    avoidSnipers: true,
                    slippage: 45
                }
            };
        case 'degen':
            return {
                mode: 'degen',
                amount: 0.006,
                takeProfit: 24,
                stopLoss: 10,
                maxConcurrentTrades: 1,
                dynamicSizing: true,
                advanced: {
                    minLiquidity: 8,
                    maxLiquidity: 300,
                    minVolume: 1.0,
                    minHolderCount: 8,
                    maxTop10: 45,
                    maxDev: 10,
                    minBondingCurve: 0.75,
                    maxBondingCurve: 30,
                    minVelocity: 0.35,
                    rugCheckStrictness: 'standard',
                    requireSocials: false,
                    avoidSnipers: true,
                    slippage: 18
                }
            };
        case 'sniper':
            return {
                mode: 'sniper',
                amount: 0.004,
                takeProfit: 30,
                stopLoss: 12,
                maxConcurrentTrades: 1,
                dynamicSizing: false,
                advanced: {
                    minLiquidity: 2,
                    maxLiquidity: 150,
                    minVolume: 0,
                    minHolderCount: 0,
                    maxTop10: 65,
                    maxDev: 20,
                    minBondingCurve: 0,
                    maxBondingCurve: 8,
                    minVelocity: 0,
                    rugCheckStrictness: 'standard',
                    requireSocials: false,
                    avoidSnipers: false,
                    slippage: 20
                }
            };
        case 'custom':
        default:
            return {
                mode: 'custom',
                amount: 0.008,
                takeProfit: 20,
                stopLoss: 10,
                maxConcurrentTrades: 1,
                dynamicSizing: true,
                advanced: {
                    minLiquidity: 10,
                    maxLiquidity: 1000,
                    minVolume: 5,
                    minHolderCount: 20,
                    maxTop10: 40,
                    maxDev: 5,
                    minBondingCurve: 5,
                    maxBondingCurve: 20,
                    minVelocity: 0.5,
                    rugCheckStrictness: 'strict',
                    requireSocials: true,
                    avoidSnipers: true,
                    slippage: 20
                }
            };
    }
}
