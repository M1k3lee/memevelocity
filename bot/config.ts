import path from 'path';
import { config as loadEnv } from 'dotenv';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import type { AdvancedConfig } from '../utils/enhancedAnalyzer';
import { getStrategyPresetConfig, normalizeStrategyProfile } from '../utils/strategyProfiles';
import type { BotMode, ManagedExitStrategy, RunnerConfig } from './types';

loadEnv({ path: path.resolve(process.cwd(), '.env.local'), quiet: true });
loadEnv({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const SUPPORTED_MODES: BotMode[] = ['runner', 'sniper', 'degen', 'god', 'safe', 'medium', 'high', 'velocity', 'first', 'scalp'];

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
    if (value === undefined || value.trim() === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveMode(rawMode: string | undefined): BotMode {
    if (!rawMode) return 'god';
    const normalized = rawMode.trim().toLowerCase() as BotMode;
    return SUPPORTED_MODES.includes(normalized) ? normalized : 'god';
}

export function getPresetAdvancedConfig(mode: BotMode): AdvancedConfig {
    return {
        ...getStrategyPresetConfig(normalizeStrategyProfile(mode)).advanced
    };
}

function getPresetExitStrategy(mode: BotMode): ManagedExitStrategy {
    if (mode === 'god') {
        return {
            takeProfit: 24,
            takeProfit2: 60,
            stopLoss: 6,
            maxHoldTime: 210,
            trailingStop: false,
            fastKillLoss: 3.8,
            fastKillSeconds: 11,
            givebackPeakTrigger: 7,
            givebackFloor: 4,
            givebackSeconds: 30,
            stagnationSeconds: 65,
            stagnationFloor: 0.5,
            tp1SellPercent: 45,
            tp2SellPercent: 25,
            postTp1FloorPercent: 6,
            postTp2FloorPercent: 14,
            runnerMaxHoldTime: 480,
            runnerTrailingStopPercent: 16,
            runnerActivationProfit: 28,
            runnerTimeExitFloor: 8
        };
    }

    if (mode === 'sniper' || mode === 'first') {
        return {
            takeProfit: 10,
            takeProfit2: 18,
            stopLoss: 6,
            maxHoldTime: 45,
            trailingStop: false,
            fastKillLoss: 3.2,
            fastKillSeconds: 8,
            givebackPeakTrigger: 4,
            givebackFloor: 2.5,
            givebackSeconds: 16,
            stagnationSeconds: 22,
            stagnationFloor: -1.5,
            tp1SellPercent: 55,
            tp2SellPercent: 25,
            postTp1FloorPercent: 3.5,
            postTp2FloorPercent: 8,
            runnerMaxHoldTime: 120,
            runnerTrailingStopPercent: 10,
            runnerActivationProfit: 10,
            runnerTimeExitFloor: 3
        };
    }

    if (mode === 'degen' || mode === 'velocity' || mode === 'high' || mode === 'scalp') {
        return {
            takeProfit: 10,
            takeProfit2: 18,
            stopLoss: 5.5,
            maxHoldTime: 55,
            trailingStop: false,
            fastKillLoss: 3.2,
            fastKillSeconds: 9,
            givebackPeakTrigger: 4,
            givebackFloor: 2.2,
            givebackSeconds: 16,
            stagnationSeconds: 22,
            stagnationFloor: -1.5,
            tp1SellPercent: 50,
            tp2SellPercent: 25,
            postTp1FloorPercent: 3.5,
            postTp2FloorPercent: 8,
            runnerMaxHoldTime: 130,
            runnerTrailingStopPercent: 9,
            runnerActivationProfit: 10,
            runnerTimeExitFloor: 3
        };
    }

    return {
        takeProfit: 32,
        takeProfit2: 95,
        stopLoss: 9,
        maxHoldTime: 270,
        trailingStop: false,
        fastKillLoss: 5,
        fastKillSeconds: 14,
        givebackPeakTrigger: 10,
        givebackFloor: 5,
        givebackSeconds: 32,
        stagnationSeconds: 90,
        stagnationFloor: -0.5,
        tp1SellPercent: 40,
        tp2SellPercent: 30,
        postTp1FloorPercent: 8,
        postTp2FloorPercent: 16,
        runnerMaxHoldTime: 960,
        runnerTrailingStopPercent: 20,
        runnerActivationProfit: 30,
        runnerTimeExitFloor: 12
    };
}

function getPresetRiskControls(mode: BotMode): { maxConsecutiveLosses: number; maxDailyLossSol: number; riskFloorMultiplier: number; riskCeilingMultiplier: number } {
    if (mode === 'god') {
        return {
            maxConsecutiveLosses: 2,
            maxDailyLossSol: 0.008,
            riskFloorMultiplier: 0.6,
            riskCeilingMultiplier: 1.35
        };
    }

    if (mode === 'sniper' || mode === 'first') {
        return {
            maxConsecutiveLosses: 3,
            maxDailyLossSol: 0.005,
            riskFloorMultiplier: 0.45,
            riskCeilingMultiplier: 1.05
        };
    }

    if (mode === 'degen' || mode === 'velocity' || mode === 'high' || mode === 'scalp') {
        return {
            maxConsecutiveLosses: 3,
            maxDailyLossSol: 0.006,
            riskFloorMultiplier: 0.5,
            riskCeilingMultiplier: 1.15
        };
    }

    return {
        maxConsecutiveLosses: 2,
        maxDailyLossSol: 0.01,
        riskFloorMultiplier: 0.55,
        riskCeilingMultiplier: 1.2
    };
}

function withAdvancedOverrides(base: AdvancedConfig): AdvancedConfig {
    return {
        ...base,
        minLiquidity: parseNumber(process.env.BOT_MIN_LIQUIDITY_SOL, base.minLiquidity ?? 0),
        maxLiquidity: parseNumber(process.env.BOT_MAX_LIQUIDITY_SOL, base.maxLiquidity ?? Number.MAX_SAFE_INTEGER),
        minVolume: parseNumber(process.env.BOT_MIN_OBSERVED_VOLUME_SOL, base.minVolume ?? 0),
        minHolderCount: parseNumber(process.env.BOT_MIN_HOLDER_COUNT, base.minHolderCount ?? 0),
        maxTop10: parseNumber(process.env.BOT_MAX_TOP10_PCT, base.maxTop10 ?? 100),
        maxDev: parseNumber(process.env.BOT_MAX_CREATOR_PCT, base.maxDev ?? 100),
        minBondingCurve: parseNumber(process.env.BOT_MIN_BONDING_CURVE_PCT, base.minBondingCurve ?? 0),
        maxBondingCurve: parseNumber(process.env.BOT_MAX_BONDING_CURVE_PCT, base.maxBondingCurve ?? 100),
        minVelocity: parseNumber(process.env.BOT_MIN_CURVE_VELOCITY, base.minVelocity ?? 0),
        rugCheckStrictness: (process.env.BOT_RUG_STRICTNESS as AdvancedConfig['rugCheckStrictness']) || base.rugCheckStrictness,
        requireSocials: parseBoolean(process.env.BOT_REQUIRE_SOCIALS, base.requireSocials ?? false),
        avoidSnipers: parseBoolean(process.env.BOT_AVOID_SNIPERS, base.avoidSnipers ?? false),
        slippage: parseNumber(process.env.BOT_SLIPPAGE_PCT, base.slippage ?? 20)
    };
}

function withExitOverrides(base: ManagedExitStrategy): ManagedExitStrategy {
    return {
        ...base,
        takeProfit: parseNumber(process.env.BOT_TAKE_PROFIT_PCT, base.takeProfit),
        takeProfit2: process.env.BOT_TAKE_PROFIT2_PCT ? parseNumber(process.env.BOT_TAKE_PROFIT2_PCT, base.takeProfit2 ?? 0) : base.takeProfit2,
        stopLoss: parseNumber(process.env.BOT_STOP_LOSS_PCT, base.stopLoss),
        maxHoldTime: parseNumber(process.env.BOT_MAX_HOLD_SECONDS, base.maxHoldTime),
        trailingStop: parseBoolean(process.env.BOT_USE_TRAILING_STOP, base.trailingStop),
        trailingStopPercent: process.env.BOT_TRAILING_STOP_PCT ? parseNumber(process.env.BOT_TRAILING_STOP_PCT, base.trailingStopPercent ?? 10) : base.trailingStopPercent
    };
}

export function parseConfiguredWallet(secret: string): Keypair {
    const trimmed = secret.trim();
    if (!trimmed) {
        throw new Error('TRADER_PRIVATE_KEY is empty');
    }

    if (trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
            throw new Error('TRADER_PRIVATE_KEY JSON format is invalid');
        }
        return Keypair.fromSecretKey(Uint8Array.from(parsed));
    }

    return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export function getConfiguredWallet(): Keypair | null {
    const secret = process.env.TRADER_PRIVATE_KEY?.trim() || '';
    if (!secret) return null;
    return parseConfiguredWallet(secret);
}

export function loadRunnerConfig(): RunnerConfig {
    const mode = resolveMode(process.env.BOT_MODE);
    const advanced = withAdvancedOverrides(getPresetAdvancedConfig(mode));
    const defaultExit = withExitOverrides(getPresetExitStrategy(mode));
    const riskControls = getPresetRiskControls(mode);
    const wallet = getConfiguredWallet();
    const statePath = process.env.BOT_STATE_PATH
        ? path.resolve(process.cwd(), process.env.BOT_STATE_PATH)
        : path.resolve(process.cwd(), 'runtime', 'bot-state.json');

    return {
        dryRun: parseBoolean(process.env.BOT_DRY_RUN, true),
        heliusKey: process.env.HELIUS_API_KEY?.trim() || '',
        walletAddress: wallet ? wallet.publicKey.toBase58() : null,
        walletSecret: process.env.TRADER_PRIVATE_KEY?.trim() || '',
        mode,
        amountSol: parseNumber(process.env.BOT_TRADE_AMOUNT_SOL, 0.01),
        slippage: advanced.slippage ?? 20,
        maxConcurrentTrades: Math.max(1, Math.floor(parseNumber(process.env.BOT_MAX_CONCURRENT_TRADES, 1))),
        minTimeBetweenTradesMs: Math.max(0, parseNumber(process.env.BOT_MIN_MS_BETWEEN_TRADES, 500)),
        dynamicSizing: parseBoolean(process.env.BOT_USE_DYNAMIC_SIZING, true),
        minBalanceReserveSol: Math.max(0.01, parseNumber(process.env.BOT_MIN_BALANCE_RESERVE_SOL, 0.02)),
        analysisCooldownMs: Math.max(250, parseNumber(process.env.BOT_ANALYSIS_COOLDOWN_MS, 1000)),
        healthLogIntervalMs: Math.max(10_000, parseNumber(process.env.BOT_HEALTH_LOG_INTERVAL_MS, 60_000)),
        pricePollIntervalMs: Math.max(1_000, parseNumber(process.env.BOT_PRICE_POLL_INTERVAL_MS, 2_000)),
        maxTrackedMints: Math.max(50, Math.floor(parseNumber(process.env.BOT_MAX_TRACKED_MINTS, 200))),
        maxConsecutiveLosses: Math.max(1, Math.floor(parseNumber(process.env.BOT_MAX_CONSECUTIVE_LOSSES, riskControls.maxConsecutiveLosses))),
        maxDailyLossSol: Math.max(0.001, parseNumber(process.env.BOT_MAX_DAILY_LOSS_SOL, riskControls.maxDailyLossSol)),
        riskFloorMultiplier: Math.max(0.2, parseNumber(process.env.BOT_RISK_FLOOR_MULTIPLIER, riskControls.riskFloorMultiplier)),
        riskCeilingMultiplier: Math.max(0.5, parseNumber(process.env.BOT_RISK_CEILING_MULTIPLIER, riskControls.riskCeilingMultiplier)),
        statePath,
        advanced,
        defaultExit
    };
}
