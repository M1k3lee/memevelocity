import assert from 'node:assert/strict';
import { getStrategyPresetConfig, normalizeStrategyProfile } from '../utils/strategyProfiles';
import { getPresetAdvancedConfig, resolveMode } from './config';
import { resolveReplayScenarios, runReplaySet, type RunResult, type StrategyName } from './paperReplay';
import type { BotMode } from './types';

type RegressionCase = {
    name: string;
    run: () => void;
};

type ReplayIndex = Map<string, Map<StrategyName, RunResult>>;

// Canonical BotMode values now map 1:1 to a VisibleStrategyMode.
// Legacy env strings ('runner', 'safe', 'medium', 'high', 'velocity',
// 'scalp', 'first') are no longer valid BotMode values but must still
// resolve to the right canonical mode via resolveMode() for backward
// compatibility with older .env files and saved UI configs.
const CANONICAL_PRESET_CASES: Array<{ mode: BotMode; expectedProfile: ReturnType<typeof normalizeStrategyProfile> }> = [
    { mode: 'god', expectedProfile: 'god' },
    { mode: 'micro', expectedProfile: 'micro' },
    { mode: 'degen', expectedProfile: 'degen' },
    { mode: 'sniper', expectedProfile: 'sniper' },
    { mode: 'custom', expectedProfile: 'custom' }
];

const LEGACY_ENV_ALIAS_CASES: Array<{ env: string; expectedMode: BotMode }> = [
    { env: 'runner', expectedMode: 'god' },
    { env: 'safe', expectedMode: 'god' },
    { env: 'medium', expectedMode: 'god' },
    { env: 'high', expectedMode: 'degen' },
    { env: 'velocity', expectedMode: 'degen' },
    { env: 'scalp', expectedMode: 'degen' },
    { env: 'first', expectedMode: 'sniper' },
    { env: 'GOD', expectedMode: 'god' },
    { env: '  degen  ', expectedMode: 'degen' },
    { env: 'bogus', expectedMode: 'god' }
];

function buildReplayIndex(): {
    sourceKind: 'capture' | 'capture-pack';
    sourcePath: string;
    labels: Map<string, number>;
    resultIndex: ReplayIndex;
} {
    const replaySource = resolveReplayScenarios([]);
    const resultsByStrategy = runReplaySet(replaySource.scenarios);
    const resultIndex: ReplayIndex = new Map();
    const labels = new Map<string, number>();

    replaySource.scenarios.forEach((scenario, scenarioIndex) => {
        const perStrategy = new Map<StrategyName, RunResult>();
        for (const [strategy, results] of resultsByStrategy.entries()) {
            const result = results[scenarioIndex];
            if (result) {
                perStrategy.set(strategy, result);
            }
        }
        resultIndex.set(scenario.id, perStrategy);
        const label = scenario.outcomeLabel || 'unlabeled';
        labels.set(label, (labels.get(label) || 0) + 1);
    });

    return {
        sourceKind: replaySource.sourceKind,
        sourcePath: replaySource.sourcePath,
        labels,
        resultIndex
    };
}

function getScenarioResult(index: ReplayIndex, scenarioId: string, strategy: StrategyName): RunResult {
    const scenarioResults = index.get(scenarioId);
    if (!scenarioResults) {
        throw new Error(`Missing replay scenario: ${scenarioId}`);
    }

    const result = scenarioResults.get(strategy);
    if (!result) {
        throw new Error(`Missing replay result for ${scenarioId}/${strategy}`);
    }

    return result;
}

function assertNoEntry(index: ReplayIndex, scenarioId: string, strategies: StrategyName[], caseName: string): void {
    for (const strategy of strategies) {
        const result = getScenarioResult(index, scenarioId, strategy);
        assert.equal(result.entered, false, `${caseName}: expected ${strategy} to stay out, got ${result.closeReason}`);
    }
}

function assertProtectiveExit(index: ReplayIndex, scenarioId: string, strategy: StrategyName, allowedReasons: string[], caseName: string): void {
    const result = getScenarioResult(index, scenarioId, strategy);
    if (!result.entered) {
        return;
    }

    assert.ok(
        allowedReasons.includes(result.closeReason),
        `${caseName}: expected ${strategy} to close defensively, got ${result.closeReason}`
    );
}

const replay = buildReplayIndex();

const CASES: RegressionCase[] = [
    {
        name: 'canonical modes map 1:1 to strategy presets',
        run: () => {
            for (const { mode, expectedProfile } of CANONICAL_PRESET_CASES) {
                assert.deepEqual(
                    getPresetAdvancedConfig(mode),
                    getStrategyPresetConfig(expectedProfile).advanced,
                    `preset parity mismatch for ${mode}`
                );
            }
        }
    },
    {
        name: 'legacy env mode strings resolve to canonical modes',
        run: () => {
            for (const { env, expectedMode } of LEGACY_ENV_ALIAS_CASES) {
                assert.equal(
                    resolveMode(env),
                    expectedMode,
                    `legacy env alias "${env}" should resolve to ${expectedMode}`
                );
            }
            // Empty / undefined inputs should fall back to god.
            assert.equal(resolveMode(undefined), 'god', 'undefined env should resolve to god');
            assert.equal(resolveMode(''), 'god', 'empty env should resolve to god');
        }
    },
    {
        name: 'default replay source is bundled real capture pack',
        run: () => {
            assert.equal(replay.sourceKind, 'capture-pack', `expected bundled capture-pack source, got ${replay.sourceKind} (${replay.sourcePath})`);
        }
    },
    {
        name: 'real replay pack covers key launch outcomes',
        run: () => {
            for (const label of ['breakout', 'creator-exit', 'dead', 'ruggy']) {
                assert.ok((replay.labels.get(label) || 0) > 0, `expected replay pack to include ${label} coverage`);
            }
        }
    },
    {
        name: 'guarded modes reject early creator-exit tape',
        run: () => {
            assertNoEntry(replay.resultIndex, 'wig-fvyutt', ['strict', 'aggressive', 'probe'], 'creator exit');
        }
    },
    {
        name: 'guarded modes reject dead tape',
        run: () => {
            assertNoEntry(replay.resultIndex, 'retardick-bpdnih', ['strict', 'aggressive', 'probe'], 'dead tape');
        }
    },
    {
        name: 'real breakout still triggers at least one guarded entry',
        run: () => {
            const swordStrict = getScenarioResult(replay.resultIndex, 'sword-hkc82o', 'strict');
            const swordAggressive = getScenarioResult(replay.resultIndex, 'sword-hkc82o', 'aggressive');
            const swordProbe = getScenarioResult(replay.resultIndex, 'sword-hkc82o', 'probe');
            assert.ok(
                swordStrict.entered || swordAggressive.entered || swordProbe.entered,
                'expected at least one guarded mode to engage on a real breakout tape'
            );
        }
    },
    {
        name: 'strict stays out on captured ruggy reversals',
        run: () => {
            assertNoEntry(replay.resultIndex, 'milkers-6amhge', ['strict'], 'ruggy reversal');
            assertNoEntry(replay.resultIndex, 'milkers-7qikkz', ['strict'], 'ruggy reversal');
        }
    },
    {
        name: 'fast modes cut ruggy reversals defensively',
        run: () => {
            const allowed = ['fast-kill', 'stop-loss', 'giveback-exit', 'stagnation-exit'];
            assertProtectiveExit(replay.resultIndex, 'milkers-6amhge', 'probe', allowed, 'ruggy fast exit');
            assertProtectiveExit(replay.resultIndex, 'milkers-7qikkz', 'aggressive', allowed, 'ruggy fast exit');
            assertProtectiveExit(replay.resultIndex, 'milkers-7qikkz', 'probe', allowed, 'ruggy fast exit');
        }
    }
];

function run(): void {
    console.log('Mode Regression');
    console.log(`Replay source: ${replay.sourcePath}`);
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
