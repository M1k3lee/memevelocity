import fs from 'fs/promises';
import path from 'path';
import type { BotState } from './types';

function createEmptyState(walletAddress: string | null): BotState {
    const now = Date.now();
    return {
        version: 1,
        walletAddress,
        startedAt: now,
        updatedAt: now,
        totals: {
            realizedProfitSol: 0,
            wins: 0,
            losses: 0,
            trades: 0
        },
        openPositions: [],
        closedPositions: [],
        logs: []
    };
}

export async function loadState(statePath: string, walletAddress: string | null): Promise<BotState> {
    try {
        const raw = await fs.readFile(statePath, 'utf8');
        const parsed = JSON.parse(raw) as BotState;
        if (parsed.walletAddress && walletAddress && parsed.walletAddress !== walletAddress) {
            return createEmptyState(walletAddress);
        }
        return {
            ...createEmptyState(walletAddress),
            ...parsed,
            walletAddress
        };
    } catch {
        return createEmptyState(walletAddress);
    }
}

export async function saveState(statePath: string, state: BotState): Promise<void> {
    const directory = path.dirname(statePath);
    await fs.mkdir(directory, { recursive: true });

    const serialized: BotState = {
        ...state,
        updatedAt: Date.now(),
        closedPositions: state.closedPositions.slice(0, 200),
        logs: state.logs.slice(0, 200)
    };

    await fs.writeFile(statePath, JSON.stringify(serialized, null, 2), 'utf8');
}
