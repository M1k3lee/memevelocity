# MEMEVELOCITY - Pump.fun Auto Trader

## Overview
This is a high-velocity, automated trading dashboard designed for the Pump.fun ecosystem on Solana. It bypasses the need for the official frontend by treating directly with the Pump.fun program via the PumpPortal API, effectively acting as a workaround for any regional frontend restrictions.

## Features
- **Wallet Generator**: Create or Import Solana wallets directly in the browser. Keys stay local.
- **Live Feed Scanner**: Monitors the Pump.fun bonding curve for new launches in real-time.
- **Auto-Trading Modes**:
  - **Safe-ish**: Filters for higher liquidity (basic), takes profit early (20%).
  - **Medium**: Balanced risk/reward (50%).
  - **High Risk**: Apes into everything. (Not Recommended).
- **Portfolio Management**: View active trades, real-time PnL, and manual Sell/Close overrides.

## Setup
1. Run `npm install`
2. Run `npm run dev`
3. Open `http://localhost:3000`

## Usage
1. **Connect Wallet**: Create a new wallet or import a private key.
2. **Fund Wallet**: Send SOL to the displayed address.
3. **Configure Bot**: Select your risk mode and "Start Autotrading".
4. **Monitor**: Watch the live feed and active trades. The bot will buy automatically.
5. **Withdraw**: Use the transfer tool to move profits to a cold wallet.

## DISCLAIMER
**HIGH RISK SOFTWARE.** This software interacts with highly volatile assets. There is no guarantee of profit. The "Safe" mode is a relative term; all memecoin trading is high risk. Use small amounts.
The developer is not responsible for any financial losses.
