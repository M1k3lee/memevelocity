import type { ManagedExitStrategy } from './tradeExit';

export type ExitPresetMode = 'god' | 'micro' | 'degen' | 'sniper' | 'custom';

// Asymmetric exit ladders. The distribution of pump.fun outcomes is heavily
// skewed: the rare runner pays for all the stopped rugs. So every mode shares
// the same shape — kill dead/red entries within seconds, take a partial at a
// cost-covering TP1, and trail the remainder far so a 60%+ run is captured.
export function getPresetExitStrategy(mode: ExitPresetMode): ManagedExitStrategy {
    switch (mode) {
        case 'god':
            return {
                takeProfit: 18,
                takeProfit2: 45,
                stopLoss: 7,
                maxHoldTime: 100,
                trailingStop: false,
                fastKillLoss: 4,
                fastKillSeconds: 3,
                givebackPeakTrigger: 6,
                givebackFloor: 2,
                givebackSeconds: 12,
                stagnationSeconds: 40,
                stagnationFloor: 0,
                tp1SellPercent: 50,
                tp2SellPercent: 25,
                postTp1FloorPercent: 4,
                postTp2FloorPercent: 10,
                runnerMaxHoldTime: 300,
                runnerTrailingStopPercent: 20,
                runnerActivationProfit: 15,
                runnerTimeExitFloor: 4
            };
        case 'micro':
            return {
                takeProfit: 15,
                takeProfit2: 40,
                stopLoss: 7,
                maxHoldTime: 90,
                trailingStop: false,
                fastKillLoss: 4,
                fastKillSeconds: 3,
                givebackPeakTrigger: 6,
                givebackFloor: 2,
                givebackSeconds: 12,
                stagnationSeconds: 40,
                stagnationFloor: 0,
                tp1SellPercent: 50,
                tp2SellPercent: 25,
                postTp1FloorPercent: 4,
                postTp2FloorPercent: 9,
                runnerMaxHoldTime: 280,
                runnerTrailingStopPercent: 18,
                runnerActivationProfit: 13,
                runnerTimeExitFloor: 4
            };
        case 'sniper':
            return {
                takeProfit: 12,
                takeProfit2: 30,
                stopLoss: 6,
                maxHoldTime: 60,
                trailingStop: false,
                fastKillLoss: 4,
                fastKillSeconds: 3,
                givebackPeakTrigger: 5,
                givebackFloor: 1.5,
                givebackSeconds: 10,
                stagnationSeconds: 30,
                stagnationFloor: 0,
                tp1SellPercent: 55,
                tp2SellPercent: 25,
                postTp1FloorPercent: 3.5,
                postTp2FloorPercent: 8,
                runnerMaxHoldTime: 180,
                runnerTrailingStopPercent: 15,
                runnerActivationProfit: 11,
                runnerTimeExitFloor: 3
            };
        case 'degen':
            return {
                takeProfit: 15,
                takeProfit2: 35,
                stopLoss: 6.5,
                maxHoldTime: 75,
                trailingStop: false,
                fastKillLoss: 4,
                fastKillSeconds: 3,
                givebackPeakTrigger: 5,
                givebackFloor: 1.5,
                givebackSeconds: 10,
                stagnationSeconds: 35,
                stagnationFloor: 0,
                tp1SellPercent: 50,
                tp2SellPercent: 25,
                postTp1FloorPercent: 3.5,
                postTp2FloorPercent: 8,
                runnerMaxHoldTime: 220,
                runnerTrailingStopPercent: 16,
                runnerActivationProfit: 12,
                runnerTimeExitFloor: 3
            };
        case 'custom':
        default:
            return {
                takeProfit: 18,
                takeProfit2: 45,
                stopLoss: 7,
                maxHoldTime: 100,
                trailingStop: false,
                fastKillLoss: 4,
                fastKillSeconds: 3,
                givebackPeakTrigger: 6,
                givebackFloor: 2,
                givebackSeconds: 12,
                stagnationSeconds: 40,
                stagnationFloor: 0,
                tp1SellPercent: 50,
                tp2SellPercent: 25,
                postTp1FloorPercent: 4,
                postTp2FloorPercent: 10,
                runnerMaxHoldTime: 300,
                runnerTrailingStopPercent: 20,
                runnerActivationProfit: 15,
                runnerTimeExitFloor: 4
            };
    }
}
