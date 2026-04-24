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

// Bump this when preset defaults change and saved UI configs should refresh.
export const STRATEGY_PRESET_VERSION = 3;

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
        subtitle: 'Earlier continuation entries',
        description: 'Takes earlier continuation setups after a real shakeout, with faster exits and tighter anti-rug filters.'
    },
    {
        id: 'sniper',
        label: 'Experimental',
        subtitle: 'Earliest entries, smallest size',
        description: 'Structured launch probe mode. Tiny size only, multi-wallet flow required, and still best kept in paper testing first.'
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
                amount: 0.006,
                takeProfit: 24,
                stopLoss: 4,
                maxConcurrentTrades: 1,
                dynamicSizing: true,
                advanced: {
                    minLiquidity: 36,
                    maxLiquidity: 125,
                    minVolume: 1.25,
                    minHolderCount: 12,
                    maxTop10: 22,
                    maxDev: 3,
                    minBondingCurve: 1.5,
                    maxBondingCurve: 11,
                    minVelocity: 0.85,
                    rugCheckStrictness: 'strict',
                    requireSocials: false,
                    avoidSnipers: true,
                    slippage: 12
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
                    maxBondingCurve: 12,
                    minVelocity: 0.6,
                    rugCheckStrictness: 'standard',
                    requireSocials: false,
                    avoidSnipers: true,
                    slippage: 45
                }
            };
        case 'degen':
            return {
                mode: 'degen',
                amount: 0.0025,
                takeProfit: 8,
                stopLoss: 4,
                maxConcurrentTrades: 1,
                dynamicSizing: false,
                advanced: {
                    minLiquidity: 32,
                    maxLiquidity: 140,
                    minVolume: 1.2,
                    minHolderCount: 6,
                    maxTop10: 42,
                    maxDev: 8,
                    minBondingCurve: 1.5,
                    maxBondingCurve: 14,
                    minVelocity: 0.85,
                    rugCheckStrictness: 'standard',
                    requireSocials: false,
                    avoidSnipers: true,
                    slippage: 12
                }
            };
        case 'sniper':
            return {
                mode: 'sniper',
                amount: 0.002,
                takeProfit: 8,
                stopLoss: 4,
                maxConcurrentTrades: 1,
                dynamicSizing: false,
                advanced: {
                    minLiquidity: 31.2,
                    maxLiquidity: 70,
                    minVolume: 0.75,
                    minHolderCount: 3,
                    maxTop10: 50,
                    maxDev: 12,
                    minBondingCurve: 0.15,
                    maxBondingCurve: 4.5,
                    minVelocity: 0.2,
                    rugCheckStrictness: 'standard',
                    requireSocials: false,
                    avoidSnipers: true,
                    slippage: 12
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
                    maxBondingCurve: 15,
                    minVelocity: 0.7,
                    rugCheckStrictness: 'strict',
                    requireSocials: true,
                    avoidSnipers: true,
                    slippage: 20
                }
            };
    }
}
