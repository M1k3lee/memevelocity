import path from 'path';
import { config as loadEnv } from 'dotenv';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import type { AdvancedConfig } from '../utils/enhancedAnalyzer';
import type { BotMode, ManagedExitStrategy, RunnerConfig } from './types';

loadEnv({ path: path.resolve(process.cwd(), '.env.local'), quiet: true });
loadEnv({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const SUPPORTED_MODES: BotMode[] = ['runner', 'sniper', 'degen', 'safe', 'medium', 'high', 'velocity', 'first', 'scalp'];

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
    if (!rawMode) return 'runner';
    const normalized = rawMode.trim().toLowerCase() as BotMode;
    return SUPPORTED_MODES.includes(normalized) ? normalized : 'runner';
}

function getPresetAdvancedConfig(mode: BotMode): AdvancedConfig {
    if (mode === 'sniper' || mode === 'high' || mode === 'first' || mode === 'scalp') {
        return {
            minLiquidity: 1,
            maxLiquidity: 500,
            minVolume: 0,
            minHolderCount: 0,
            maxTop10: 90,
            maxDev: 50,
            minBondingCurve: 0,
            maxBondingCurve: 10,
            minVelocity: 0,
            rugCheckStrictness: 'lenient',
            requireSocials: false,
            avoidSnipers: false,
            slippage: 30
        };
    }

    if (mode === 'degen' || mode === 'velocity') {
        return {
            minLiquidity: 5,
            maxLiquidity: 2000,
            minVolume: 2,
            minHolderCount: 10,
            maxTop10: 60,
            maxDev: 15,
            minBondingCurve: 1,
            maxBondingCurve: 60,
            minVelocity: 1,
            rugCheckStrictness: 'standard',
            requireSocials: false,
            avoidSnipers: false,
            slippage: 25
        };
    }

    return {
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
    };
}

function getPresetExitStrategy(mode: BotMode): ManagedExitStrategy {
    if (mode === 'sniper' || mode === 'high' || mode === 'first' || mode === 'scalp') {
        return {
            takeProfit: 50,
            stopLoss: 15,
            maxHoldTime: 180,
            trailingStop: true,
            trailingStopPercent: 12
        };
    }

    if (mode === 'degen' || mode === 'velocity') {
        return {
            takeProfit: 100,
            takeProfit2: 200,
            stopLoss: 25,
            maxHoldTime: 300,
            trailingStop: true,
            trailingStopPercent: 15
        };
    }

    return {
        takeProfit: 30,
        takeProfit2: 120,
        stopLoss: 10,
        maxHoldTime: 600,
        trailingStop: true,
        trailingStopPercent: 10
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
        statePath,
        advanced,
        defaultExit
    };
}
