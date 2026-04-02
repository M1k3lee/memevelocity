# MemeVelocity

Pump.fun trading workstation for Solana.

MemeVelocity is a Next.js dashboard plus a Node runner for finding new launches, filtering obvious junk, paper trading, and managing live positions with staged exits. It is built for fast launch monitoring, not for passive long-term investing.

## What It Can Do

- Watch PumpPortal token creation and token trade flow in real time
- Run browser-based paper trading with portfolio, logs, and trade history
- Run an unattended Node bot with persistent state outside the browser
- Score launches with technical safety, holder quality, flow, and bonding-curve context
- Reject common rug patterns such as copycats, creator-led dumps, thin liquidity, and concentrated early flow
- Manage exits with stop loss, staged take profit, fast-kill rules, giveback protection, and runner trailing logic
- Record live feed data and replay paper scenarios for strategy testing

## Trading Modes

- `Conservative`
  Waits for cleaner second-wave confirmation. Best for avoiding obvious traps and limiting bad entries.

- `Balanced`
  Looks for reclaim setups and controlled continuation. More active than Conservative, still selective.

- `Aggressive`
  Buys earlier continuation when momentum is strong. Faster entries, faster exits, higher failure rate.

- `Experimental`
  Earliest-entry mode. Useful for paper testing and tiny size only.

- `Custom`
  Manual control over liquidity, holder, curve, velocity, and slippage thresholds.

## Core Features

- `Live feed`
  Real-time PumpPortal subscriptions for launches and per-token trade updates.

- `Analyzer`
  Combines contract safety, holder concentration, creator exposure, buy pressure, and curve velocity.

- `Paper trading`
  Simulated fills, fees, rent handling, PnL tracking, active trades, and history.

- `Live runner`
  Node worker that can trade outside the browser and keep state on disk across restarts.

- `Exit engine`
  Supports staged profit taking, time exits, fast stop logic, profit lock floors, and moonbag runner logic.

- `Wallet tools`
  Local wallet creation/import, funding display, balance checks, recovery scans, and empty token-account cleanup.

- `Research tooling`
  Deterministic paper replay and live PumpPortal capture for strategy validation.

## How It Works

1. New launch or token-trade events arrive from PumpPortal.
2. Market snapshots are built from observed liquidity, volume, wallet count, and flow concentration.
3. The analyzer and live entry guard decide whether the setup is tradeable.
4. Paper or live execution runs with sizing, slippage, and exit rules.
5. Open trades are managed until stop, take profit, staged exit, or time exit.

## Quick Start

```bash
git clone https://github.com/M1k3lee/memevelocity.git
cd memevelocity
npm install
npm run dev
```

Open `http://localhost:3000`.

## Useful Scripts

```bash
# app
npm run dev
npm run build
npm start

# unattended bot
npm run bot:wallet
npm run bot:start

# strategy tooling
npm run verify:modes
npm run paper:replay
npm run paper:capture -- 10
```

## Runtime Notes

- `Helius` is optional for the UI, but strongly recommended for better RPC quality.
- `TRADER_PRIVATE_KEY` is required for live runner mode.
- `BOT_DRY_RUN=true` is the correct first live-runner setting.
- Captured live feed files are written under `runtime/captures`.
- Runner state is stored under `runtime/`.

## Main Config Knobs

- `BOT_MODE`
- `BOT_TRADE_AMOUNT_SOL`
- `BOT_MAX_CONCURRENT_TRADES`
- `BOT_MIN_MS_BETWEEN_TRADES`
- `BOT_SLIPPAGE_PCT`
- `BOT_TAKE_PROFIT_PCT`
- `BOT_STOP_LOSS_PCT`
- `BOT_DRY_RUN`
- `HELIUS_API_KEY`
- `TRADER_PRIVATE_KEY`

See [.env.example](./.env.example) and [LIVE_RUNNER.md](./LIVE_RUNNER.md).

## Project Layout

```text
app/        Next.js UI
bot/        Unattended runner and paper tools
components/ Dashboard UI
hooks/      Trading state and execution hook
types/      Shared types
utils/      Feed, analyzer, execution, exits, and market math
```

## Docs

- [HELIUS_SETUP.md](./HELIUS_SETUP.md)
- [LIVE_RUNNER.md](./LIVE_RUNNER.md)
- [PAPER_TRADING_STATUS.md](./PAPER_TRADING_STATUS.md)
- [NETWORK_TROUBLESHOOTING.md](./NETWORK_TROUBLESHOOTING.md)

## Risk

This app trades one of the worst microstructure environments in crypto. Most launches are low quality, many are manipulated, and no strategy here should be treated as guaranteed profitable. Paper trade first, keep size small, and use a dedicated wallet.
