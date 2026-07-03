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

export type VisibleStrategyMode = 'god' | 'micro' | 'degen' | 'sniper' | 'velocity' | 'custom';

// Bump this when preset defaults change and saved UI configs should refresh.
export const STRATEGY_PRESET_VERSION = 9;

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

// All modes run the same flow-based strategy (utils/flowStrategy.ts): enter
// only on early multi-wallet accumulation with real SOL inflow and a silent
// creator, exit instantly if the creator sells, cut dead entries in seconds,
// and trail the rare runner far. The modes differ only in how tight the
// thresholds are — backtests on captured live tape show PnL degrades as
// selectivity loosens, so Selective is the recommended default.
export const STRATEGY_PROFILE_DEFINITIONS: StrategyProfileDefinition[] = [
    {
        id: 'god',
        label: 'Selective',
        subtitle: 'The backtested optimum',
        description: 'Waits for the strongest accumulation signature (4+ wallets, 5+ SOL real inflow, clean tape, no chase). Trades rarely — roughly the best launch per hour — but this config was the only profitable one on captured live data.'
    },
    {
        id: 'micro',
        label: 'Balanced',
        subtitle: 'Slightly wider chase window',
        description: 'Same core signature as Selective but tolerates entries up to 40% above first price. Adds a trade or two per hour at slightly worse expected value.'
    },
    {
        id: 'degen',
        label: 'Aggressive',
        subtitle: 'Looser confirmation, longer window',
        description: 'Accepts 3-wallet confirmation and a 90s entry window. More activity, and the extra trades were roughly break-even in backtests — the creator-sell instant exit is what keeps the losses shallow.'
    },
    {
        id: 'sniper',
        label: 'Experimental',
        subtitle: 'Earliest entries, smallest size',
        description: 'Loosest thresholds and the earliest window (3s). Negative expectancy on most captured tape — keep it in paper mode for research.'
    },
    {
        id: 'velocity',
        label: 'Velocity',
        subtitle: 'Aggressive alias',
        description: 'Legacy alias that now routes through the Aggressive flow thresholds with fast exits.'
    },
    {
        id: 'custom',
        label: 'Custom',
        subtitle: 'Manual control',
        description: 'Balanced flow thresholds with your own size, TP and SL on top.'
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
        case 'scalp':
            return 'degen';
        case 'velocity':
            return 'velocity';
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
                amount: 0.05,
                takeProfit: 18,
                stopLoss: 7,
                maxConcurrentTrades: 1,
                dynamicSizing: true,
                advanced: {
                    // Pump.fun tokens launch at exactly 30 virtual SOL.
                    // 36 was rejecting every fresh launch by definition;
                    // 30 lets us see the actual launch + first few trades.
                    minLiquidity: 30,
                    maxLiquidity: 125,
                    minVolume: 0.55,
                    minHolderCount: 8,
                    maxTop10: 28,
                    maxDev: 3,
                    minBondingCurve: 1.5,
                    maxBondingCurve: 14,
                    minVelocity: 0.45,
                    rugCheckStrictness: 'strict',
                    requireSocials: false,
                    avoidSnipers: true,
                    slippage: 12
                }
            };
        case 'micro':
            return {
                mode: 'micro',
                amount: 0.04,
                takeProfit: 15,
                stopLoss: 7,
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
                    maxBondingCurve: 17,
                    minVelocity: 0.4,
                    rugCheckStrictness: 'standard',
                    requireSocials: false,
                    avoidSnipers: true,
                    slippage: 45
                }
            };
        case 'degen':
            return {
                mode: 'degen',
                amount: 0.03,
                takeProfit: 15,
                stopLoss: 6.5,
                maxConcurrentTrades: 1,
                dynamicSizing: false,
                advanced: {
                    // Pump.fun launches at 30 virtual SOL. 32 was filtering
                    // out 100% of fresh launches; 28 lets us catch entries
                    // even on tokens that briefly dip below the launch float.
                    minLiquidity: 28,
                    maxLiquidity: 140,
                    minVolume: 0.45,
                    minHolderCount: 4,
                    // The fallback holder estimator returns 52% when holderCount
                    // is in the 15–24 range and 58% when 10–14. A 42% ceiling
                    // was rejecting every fresh launch by definition; 55 lets
                    // mid-stage tokens through while still flagging genuine
                    // top-heavy distributions (>55% on >25 holders).
                    maxTop10: 55,
                    maxDev: 8,
                    minBondingCurve: 1.5,
                    maxBondingCurve: 17,
                    minVelocity: 0.35,
                    rugCheckStrictness: 'standard',
                    requireSocials: false,
                    avoidSnipers: true,
                    slippage: 12
                }
            };
        case 'sniper':
            return {
                mode: 'sniper',
                amount: 0.02,
                takeProfit: 12,
                stopLoss: 6,
                maxConcurrentTrades: 1,
                dynamicSizing: false,
                advanced: {
                    // Sniper is the *earliest* probe mode — 31.2 was nonsense
                    // since launches start at 30. Drop to 25 so we can probe
                    // the first few trades before the curve fully fills.
                    minLiquidity: 25,
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
        case 'velocity':
            return {
                // Launch-sniper mode tuned for the first 30s of token life.
                // Strategy: pay attention only to tokens that are *clearly
                // moving* (high SOL/min momentum), accept that fresh launches
                // are top-heavy by nature (don't filter on top10 at all
                // pre-launch — the analyzer's launch-phase exemption handles
                // that), and exit fast on either profit or fade.
                mode: 'velocity',
                amount: 0.02,
                takeProfit: 12,
                stopLoss: 6,
                maxConcurrentTrades: 2,
                dynamicSizing: false,
                advanced: {
                    // Pump.fun launches at exactly 30 SOL. Sit just below it
                    // so brief dips don't reject the entry.
                    minLiquidity: 26,
                    maxLiquidity: 90,
                    // Volume can be very low in the first ~5s; rely on
                    // velocity instead of volume as the entry signal.
                    minVolume: 0.4,
                    minHolderCount: 3,
                    // High ceiling — at <10% curve the analyzer skips the
                    // top10 check entirely, so this only matters once a real
                    // base of holders exists. 65 leaves room for a still-
                    // concentrated but viable post-launch token.
                    maxTop10: 65,
                    maxDev: 15,
                    minBondingCurve: 0.1,
                    // 18 (not 12) because re-analyzed tokens have already
                    // moved during the wait window — the COMMUNISM and AU
                    // tokens in production logs both rejected at 12.2%
                    // and 15.9% respectively, well within the velocity
                    // strategy's intended window. Anything past ~18% is
                    // late-chase territory and the exit math no longer
                    // works as well at those entry points.
                    maxBondingCurve: 18,
                    // The defining filter: this mode REQUIRES strong velocity.
                    // 1.2 SOL/min of curve growth is "this is moving" without
                    // being absurdly high — typical for legitimate launches.
                    minVelocity: 0.75,
                    rugCheckStrictness: 'standard',
                    requireSocials: false,
                    avoidSnipers: true,
                    // High slippage so we actually get filled on a fast tape.
                    slippage: 30
                }
            };
        case 'custom':
        default:
            return {
                mode: 'custom',
                amount: 0.05,
                takeProfit: 18,
                stopLoss: 7,
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
                    maxBondingCurve: 18,
                    minVelocity: 0.6,
                    rugCheckStrictness: 'strict',
                    requireSocials: true,
                    avoidSnipers: true,
                    slippage: 20
                }
            };
    }
}
