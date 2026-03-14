# Live Runner

The GitHub Pages build is still useful as a dashboard, but unattended trading now lives in the Node runner.

## Funding flow

1. Put your dedicated bot private key in `TRADER_PRIVATE_KEY`.
2. Set `HELIUS_API_KEY` for the live runner.
3. Run `npm run bot:wallet`.
4. Send SOL to the wallet address it prints.
5. Start in dry run first: `BOT_DRY_RUN=true`.
6. When you are satisfied with the logs and state file, switch to `BOT_DRY_RUN=false`.

Keep this wallet isolated from your main holdings. The bot state is persisted to `runtime/bot-state.json` by default.

## Commands

```bash
npm run bot:wallet
npm run bot:start
```

## Recommended first live settings

- `BOT_MODE=runner`
- `BOT_TRADE_AMOUNT_SOL=0.01`
- `BOT_MAX_CONCURRENT_TRADES=1`
- `HELIUS_API_KEY=...`
- `BOT_DRY_RUN=true` until the runner behaves the way you expect

## Notes

- The runner uses the real PumpPortal websocket feed for launches and token trades.
- It persists open positions outside the browser so restarts do not wipe trade state.
- The static UI is still exportable to GitHub Pages; the runner is a separate process.
