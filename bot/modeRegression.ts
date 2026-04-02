import assert from 'node:assert/strict';
import type { EnhancedAnalysis } from '../utils/enhancedAnalyzer';
import { clearAllMarketSnapshots, getMarketSnapshot, recordMarketEvent } from '../utils/marketData';
import { calculateBondingCurveProgress } from '../utils/pumpMath';
import { createEmptyPumpLaunchFlags } from '../utils/pumpLaunchFlags';
import { evaluateLiveEntryGuard } from '../utils/liveEntryGuard';
import { getStrategyPresetConfig, normalizeStrategyProfile } from '../utils/strategyProfiles';
import type { TokenData } from '../types/token';
import { getPresetAdvancedConfig } from './config';
import type { BotMode } from './types';

const PUMP_INITIAL_VIRTUAL_TOKENS = 1_073_000_000;
const PUMP_CURVE_SALE_TOKENS = 793_100_000;

type TapeEvent = {
    seconds: number;
    trader: string;
    txType: TokenData['txType'];
    liquiditySol: number;
    initialBuy?: number;
};

type TapeConfig = {
    mint: string;
    symbol: string;
    ageSeconds: number;
    creator?: string;
    events: TapeEvent[];
};

type RegressionCase = {
    name: string;
    run: () => void;
};

function vTokensFromProgress(progress: number): number {
    return Math.max(1, PUMP_INITIAL_VIRTUAL_TOKENS - ((progress / 100) * PUMP_CURVE_SALE_TOKENS));
}

function makeToken(params: {
    mint: string;
    symbol: string;
    creator: string;
    event: TapeEvent;
    launchTime: number;
    lastEventTime: number;
    progress: number;
}): TokenData {
    const { mint, symbol, creator, event, launchTime, lastEventTime, progress } = params;
    return {
        mint,
        traderPublicKey: event.trader,
        creatorPublicKey: creator,
        txType: event.txType,
        initialBuy: event.initialBuy || 0,
        bondingCurveKey: `${mint}-curve`,
        vTokensInBondingCurve: vTokensFromProgress(progress),
        vSolInBondingCurve: event.liquiditySol,
        marketCapSol: event.liquiditySol,
        name: symbol,
        symbol,
        uri: '',
        timestamp: lastEventTime,
        createdAt: launchTime,
        lastSeenAt: lastEventTime
    };
}

function seedTape(config: TapeConfig): TokenData {
    clearAllMarketSnapshots();
    const now = Date.now();
    const launchTime = now - (config.ageSeconds * 1000);
    const creator = config.creator || 'CREATOR';
    let latestToken: TokenData | null = null;

    for (const event of config.events) {
        const eventTime = launchTime + (event.seconds * 1000);
        const progress = Math.max(0.1, Math.min(18, (event.liquiditySol - 30) * 2.5));
        latestToken = makeToken({
            mint: config.mint,
            symbol: config.symbol,
            creator,
            event,
            launchTime,
            lastEventTime: eventTime,
            progress
        });
        recordMarketEvent(latestToken);
    }

    if (!latestToken) {
        throw new Error(`Tape ${config.symbol} had no events`);
    }

    return latestToken;
}

function buildAnalysis(token: TokenData, overrides?: Partial<EnhancedAnalysis>): EnhancedAnalysis {
    const snapshot = getMarketSnapshot(token.mint);
    const liquidity = token.vSolInBondingCurve;
    const bondingCurveProgress = calculateBondingCurveProgress(token.vTokensInBondingCurve);

    return {
        score: 82,
        riskLevel: 'low',
        passed: true,
        reasons: [],
        warnings: [],
        strengths: [],
        bondingCurveProgress,
        marketCap: liquidity,
        tiers: {
            tier0: 100,
            tier1: 8,
            tier2: 80,
            tier3: 10,
            tier4: 65,
            totalScore: 263
        },
        metrics: {
            holderCount: snapshot?.uniqueTraderCount || 0,
            deployerHoldings: -1,
            top10Concentration: 24,
            observedVolume: snapshot?.observedVolumeSol || 0,
            buyPressure: snapshot?.buyPressure || 0,
            bondingCurveVelocity: 0.8,
            liquidityDepth: liquidity,
            tradeCount: snapshot?.tradeCount || 0,
            uniqueTraderCount: snapshot?.uniqueTraderCount || 0,
            repeatTraderRatio: snapshot?.repeatTraderRatio || 0,
            averageTradeSizeSol: snapshot?.averageTradeSizeSol || 0,
            priceChangePercent: snapshot?.priceChangePercent || 0,
            maxPriceChangePercent: snapshot?.maxPriceChangePercent || 0,
            minPriceChangePercent: snapshot?.minPriceChangePercent || 0,
            peakLiquiditySol: snapshot?.peakLiquiditySol || liquidity,
            peakPrice: snapshot?.peakPrice || 0,
            largestTraderVolumeShare: snapshot?.largestTraderVolumeShare || 0,
            topTwoTraderVolumeShare: snapshot?.topTwoTraderVolumeShare || 0,
            creatorVolumeShare: snapshot?.creatorVolumeShare || 0,
            creatorNetFlowSol: snapshot?.creatorNetFlowSol || 0,
            creatorBuyCount: snapshot?.creatorBuyCount || 0,
            creatorSellCount: snapshot?.creatorSellCount || 0,
            launchFlags: createEmptyPumpLaunchFlags(),
            contractSecurity: {
                freezeAuthority: true,
                mintAuthority: true,
                updateAuthority: true,
                verified: true
            }
        },
        ...overrides
    };
}

function assertDecision(caseName: string, actual: { status: string; reason?: string }, expectedStatus: string, reasonPattern?: RegExp) {
    assert.equal(actual.status, expectedStatus, `${caseName}: expected ${expectedStatus}, got ${actual.status} (${actual.reason || 'no reason'})`);
    if (reasonPattern) {
        assert.match(actual.reason || '', reasonPattern, `${caseName}: unexpected reason "${actual.reason || ''}"`);
    }
}

const PRESET_ALIAS_CASES: Array<{ mode: BotMode; expectedProfile: ReturnType<typeof normalizeStrategyProfile> }> = [
    { mode: 'god', expectedProfile: 'god' },
    { mode: 'runner', expectedProfile: 'god' },
    { mode: 'safe', expectedProfile: 'god' },
    { mode: 'medium', expectedProfile: 'god' },
    { mode: 'degen', expectedProfile: 'degen' },
    { mode: 'high', expectedProfile: 'degen' },
    { mode: 'velocity', expectedProfile: 'degen' },
    { mode: 'scalp', expectedProfile: 'degen' },
    { mode: 'sniper', expectedProfile: 'sniper' },
    { mode: 'first', expectedProfile: 'sniper' }
];

const CASES: RegressionCase[] = [
    {
        name: 'preset alias parity',
        run: () => {
            for (const { mode, expectedProfile } of PRESET_ALIAS_CASES) {
                assert.deepEqual(
                    getPresetAdvancedConfig(mode),
                    getStrategyPresetConfig(expectedProfile).advanced,
                    `preset parity mismatch for ${mode}`
                );
            }
        }
    },
    {
        name: 'sniper waits on lone opening wallet',
        run: () => {
            const token = seedTape({
                mint: 'sniper-thin',
                symbol: 'SNTHIN',
                ageSeconds: 6,
                events: [
                    { seconds: 0, trader: 'CREATOR', txType: 'create', liquiditySol: 30.3, initialBuy: 0.3 }
                ]
            });
            const decision = evaluateLiveEntryGuard('sniper', token, buildAnalysis(token), 0.002);
            assertDecision('sniper thin tape', decision, 'wait', /second wallet|follow-through/i);
        }
    },
    {
        name: 'sniper rejects creator sell',
        run: () => {
            const token = seedTape({
                mint: 'sniper-creator-sell',
                symbol: 'SNSOLD',
                ageSeconds: 14,
                events: [
                    { seconds: 0, trader: 'CREATOR', txType: 'create', liquiditySol: 30.4, initialBuy: 0.4 },
                    { seconds: 5, trader: 'WALLET_A', txType: 'buy', liquiditySol: 30.8 },
                    { seconds: 10, trader: 'CREATOR', txType: 'sell', liquiditySol: 30.5 }
                ]
            });
            const decision = evaluateLiveEntryGuard('sniper', token, buildAnalysis(token), 0.002);
            assertDecision('sniper creator sell', decision, 'reject', /creator already sold/i);
        }
    },
    {
        name: 'sniper rejects concentrated sample after tape forms',
        run: () => {
            const token = seedTape({
                mint: 'sniper-concentrated',
                symbol: 'SNCONC',
                ageSeconds: 12,
                events: [
                    { seconds: 0, trader: 'CREATOR', txType: 'create', liquiditySol: 30.5, initialBuy: 0.5 },
                    { seconds: 4, trader: 'CREATOR', txType: 'buy', liquiditySol: 31.0 },
                    { seconds: 7, trader: 'CREATOR', txType: 'buy', liquiditySol: 31.3 },
                    { seconds: 10, trader: 'WALLET_B', txType: 'buy', liquiditySol: 31.35 }
                ]
            });
            const decision = evaluateLiveEntryGuard('sniper', token, buildAnalysis(token), 0.002);
            assertDecision('sniper concentrated tape', decision, 'reject', /dominates|top 2/i);
        }
    },
    {
        name: 'sniper passes healthy multi-wallet probe',
        run: () => {
            const token = seedTape({
                mint: 'sniper-healthy',
                symbol: 'SNPASS',
                ageSeconds: 9,
                events: [
                    { seconds: 0, trader: 'CREATOR', txType: 'create', liquiditySol: 30.4, initialBuy: 0.4 },
                    { seconds: 3, trader: 'WALLET_A', txType: 'buy', liquiditySol: 30.65 },
                    { seconds: 5, trader: 'WALLET_B', txType: 'buy', liquiditySol: 30.9 },
                    { seconds: 7, trader: 'WALLET_C', txType: 'buy', liquiditySol: 31.15 }
                ]
            });
            const decision = evaluateLiveEntryGuard('sniper', token, buildAnalysis(token), 0.002);
            assertDecision('sniper healthy tape', decision, 'pass');
        }
    },
    {
        name: 'aggressive waits on thin opening tape',
        run: () => {
            const token = seedTape({
                mint: 'degen-thin',
                symbol: 'DGTHIN',
                ageSeconds: 10,
                events: [
                    { seconds: 0, trader: 'CREATOR', txType: 'create', liquiditySol: 32.1, initialBuy: 2.1 }
                ]
            });
            const decision = evaluateLiveEntryGuard('degen', token, buildAnalysis(token, {
                bondingCurveProgress: 2.5,
                marketCap: 32.1
            }), 0.0025);
            assertDecision('aggressive thin tape', decision, 'wait', /broader aggressive flow|snapshot still syncing|needs/i);
        }
    },
    {
        name: 'aggressive rejects concentrated continuation after sample forms',
        run: () => {
            const token = seedTape({
                mint: 'degen-concentrated',
                symbol: 'DGCONC',
                ageSeconds: 24,
                events: [
                    { seconds: 0, trader: 'CREATOR', txType: 'create', liquiditySol: 32.0, initialBuy: 2.0 },
                    { seconds: 4, trader: 'WALLET_A', txType: 'buy', liquiditySol: 32.4 },
                    { seconds: 8, trader: 'WALLET_A', txType: 'sell', liquiditySol: 32.2 },
                    { seconds: 13, trader: 'WALLET_A', txType: 'buy', liquiditySol: 32.8 },
                    { seconds: 18, trader: 'WALLET_B', txType: 'buy', liquiditySol: 32.9 }
                ]
            });
            const decision = evaluateLiveEntryGuard('degen', token, buildAnalysis(token, {
                bondingCurveProgress: 4.5,
                marketCap: 32.9
            }), 0.0025);
            assertDecision('aggressive concentrated tape', decision, 'reject', /dominates|concentrated/i);
        }
    },
    {
        name: 'aggressive passes healthy continuation',
        run: () => {
            const token = seedTape({
                mint: 'degen-healthy',
                symbol: 'DGPASS',
                ageSeconds: 28,
                events: [
                    { seconds: 0, trader: 'CREATOR', txType: 'create', liquiditySol: 30.6, initialBuy: 0.6 },
                    { seconds: 3, trader: 'WALLET_A', txType: 'buy', liquiditySol: 31.15 },
                    { seconds: 6, trader: 'WALLET_B', txType: 'buy', liquiditySol: 31.55 },
                    { seconds: 9, trader: 'WALLET_C', txType: 'sell', liquiditySol: 31.25 },
                    { seconds: 12, trader: 'WALLET_D', txType: 'buy', liquiditySol: 31.8 },
                    { seconds: 15, trader: 'WALLET_E', txType: 'buy', liquiditySol: 32.3 },
                    { seconds: 18, trader: 'WALLET_F', txType: 'sell', liquiditySol: 32.0 },
                    { seconds: 21, trader: 'WALLET_G', txType: 'buy', liquiditySol: 32.55 },
                    { seconds: 24, trader: 'WALLET_H', txType: 'buy', liquiditySol: 33.05 },
                    { seconds: 27, trader: 'WALLET_I', txType: 'buy', liquiditySol: 33.45 }
                ]
            });
            const decision = evaluateLiveEntryGuard('degen', token, buildAnalysis(token, {
                bondingCurveProgress: 5.2,
                marketCap: 33.45
            }), 0.0025);
            assertDecision('aggressive healthy tape', decision, 'pass');
        }
    },
    {
        name: 'god rejects creator sell',
        run: () => {
            const token = seedTape({
                mint: 'god-creator-sell',
                symbol: 'GDSOLD',
                ageSeconds: 32,
                events: [
                    { seconds: 0, trader: 'CREATOR', txType: 'create', liquiditySol: 36.0, initialBuy: 6.0 },
                    { seconds: 6, trader: 'WALLET_A', txType: 'buy', liquiditySol: 36.4 },
                    { seconds: 12, trader: 'WALLET_B', txType: 'sell', liquiditySol: 36.2 },
                    { seconds: 20, trader: 'CREATOR', txType: 'sell', liquiditySol: 35.9 }
                ]
            });
            const decision = evaluateLiveEntryGuard('god', token, buildAnalysis(token, {
                bondingCurveProgress: 6.5,
                marketCap: 35.9
            }), 0.006);
            assertDecision('god creator sell', decision, 'reject', /creator already sold/i);
        }
    },
    {
        name: 'god waits on thin tape instead of rejecting immediately',
        run: () => {
            const token = seedTape({
                mint: 'god-thin',
                symbol: 'GDWAIT',
                ageSeconds: 12,
                events: [
                    { seconds: 0, trader: 'CREATOR', txType: 'create', liquiditySol: 36.1, initialBuy: 6.1 }
                ]
            });
            const decision = evaluateLiveEntryGuard('god', token, buildAnalysis(token, {
                bondingCurveProgress: 1.8,
                marketCap: 36.1
            }), 0.006);
            assertDecision('god thin tape', decision, 'wait', /waiting for tape|runner tape not ready/i);
        }
    }
];

function run(): void {
    console.log('Mode Regression');
    console.log('');

    for (const regressionCase of CASES) {
        regressionCase.run();
        console.log(`PASS ${regressionCase.name}`);
    }

    console.log('');
    console.log(`Completed ${CASES.length} regression checks.`);
}

try {
    run();
} catch (error: any) {
    console.error(`FAIL ${error.message || error}`);
    process.exit(1);
}
