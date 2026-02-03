# 🚀 MemeVelocity - Pump.fun Automated Trading Bot

<div align="center">

**High-velocity automated trading bot for the Pump.fun ecosystem on Solana**

[![Next.js](https://img.shields.io/badge/Next.js-16.1-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Solana](https://img.shields.io/badge/Solana-Mainnet-purple?logo=solana)](https://solana.com/)

[Features](#-features) • [Installation](#-installation) • [Configuration](#-configuration) • [Usage](#-usage) • [Safety](#-safety-warning)

</div>

---

## 📋 Overview

**MemeVelocity** is an advanced automated trading bot designed for the Pump.fun ecosystem on Solana. It provides real-time token detection, intelligent analysis, and automated trading with sophisticated rug pull detection to help you navigate the volatile memecoin market.

### Key Highlights

- ⚡ **Real-time Detection**: Monitors Pump.fun for new token launches via WebSocket
- 🛡️ **Advanced Rug Detection**: Multi-layer filtering to avoid scams and duplicate copycat tokens
- 📊 **Paper Trading Mode**: Test strategies risk-free before going live
- 🎯 **Multiple Trading Strategies**: Runner, Sniper, Degen, and Custom modes
- 🔄 **Automated Exit Strategies**: Take-profit, stop-loss, trailing stops, and momentum-based exits
- 📈 **Live Portfolio Tracking**: Real-time PnL, trade history, and performance statistics

---

## ✨ Features

### 🎮 Trading Modes

We've simplified our strategy into **three powerful modes**:

- **🏃 RUNNER (The Profit King)**
  - **Best for:** Consistent, high-quality trades.
  - **Strategy:** Uses a **4-Tier Analysis Framework** to find legitimate projects.
  - **Goal:** Catching the "real" projects that are ready to graduate bonding curves.

- **🎯 SNIPER (Speed & Precision)**
  - **Best for:** Being the first one in.
  - **Strategy:** Filters for "Technical Safety" (Tier 0) only and buys instantly.
  - **Goal:** Get in during the first 60 seconds, take a quick 50% profit, and get out.

- **🎰 DEGEN (Maximum Chaos)**
  - **Best for:** High risk, high reward.
  - **Strategy:** Ignores most safety checks in favor of raw **Momentum** and **Volume**.
  - **Goal:** Riding the hype wave. Warning: High risk of rug pulls.

### 🧠 The 4-Tier Analysis Framework

Under the hood, **MemeVelocity** uses a sophisticated "Runner Detection" engine:

1.  **Tier 0: Technical Safety** 🛡️
    - Validates metadata, authorities (freeze/mint), and honeypot risks.
2.  **Tier 1: Launch Timing** ⏱️
    - Checks for the "Golden Window" (Fri-Sun, 11-14 UTC).
3.  **Tier 2: Holder Distribution** 👥
    - Analyzes top 10 holders and developer ownership (<5%).
4.  **Tier 3 & 4: Socials & Momentum** 🚀
    - Verifies social signals and "Golden Velocity" (5-15% curve progress).

**Runner Mode** requires a pass on *all* tiers. **Sniper** only cares about Tier 0. **Degen** focuses on Momentum.

### 📊 Portfolio Management

- **Active Trades Dashboard**: Real-time view of all open positions
- **Trade History**: Complete log of all trades with PnL
- **Performance Statistics**: Win rate, total PnL, best/worst trades
- **Manual Overrides**: Sell buttons for manual intervention

### 🔌 Integration Options

- **Helius RPC**: Enhanced WebSocket support for faster data
- **Public RPC Fallback**: Works without API keys (slower)
- **PumpPortal API**: Direct integration with Pump.fun ecosystem

---

## 🚀 Installation

### Prerequisites

- Node.js 18+ and npm
- A Solana wallet (or create one in-app)
- (Optional) Helius API key for enhanced performance

### Quick Start

```bash
# Clone the repository
git clone https://github.com/M1k3lee/memevelocity.git
cd memevelocity

# Install dependencies
npm install

# Run development server
npm run dev

# Open in browser
# http://localhost:3000
```

### Production Build

```bash
# Build for production
npm run build

# Start production server
npm start
```

---

## ⚙️ Configuration

### Helius RPC Setup (Recommended)

For best performance and reliability, set up a free Helius API key:

1. Sign up at [helius.dev](https://helius.dev) (free tier available)
2. Create a new project for Solana Mainnet
3. Copy your API key
4. In the app, go to **Wallet** tab → Enter your Helius API key
5. The bot will automatically use Helius for faster data access

**Benefits:**
- ✅ Faster WebSocket connections
- ✅ Higher rate limits
- ✅ More reliable token detection
- ✅ Better real-time price updates

### Trading Configuration

Access bot settings via the **Bot Config** tab:

- **Trading Strategy**: Select Runner/Sniper/Degen/Custom
- **Trade Amount**: SOL amount per trade (default: 0.01 SOL)
- **Take Profit**: Target profit % (default: 20%)
- **Stop Loss**: Maximum loss % (default: 10%)
- **Max Concurrent Trades**: Maximum open positions (default: 5)
- **Paper Trading**: Enable to test without real funds

### Exit Strategy Customization

Each trade can have custom exit strategies:
- **Take Profit**: Automatic sell at target profit
- **Stop Loss**: Automatic exit on loss threshold
- **Trailing Stop**: Follows price up, locks in profits
- **Time-based**: Exit after X minutes
- **Momentum-based**: Exit on momentum reversal

---

## 📖 Usage

### First Time Setup

1. **Create/Import Wallet**
   - Go to **Wallet** tab
   - Click "Create New Wallet" or "Import Wallet"
   - **Important**: Save your private key securely!

2. **Fund Your Wallet** (for live trading)
   - Copy your wallet address
   - Send SOL from another wallet
   - Wait for confirmation

3. **Configure Helius** (optional but recommended)
   - Enter your Helius API key in Wallet tab
   - This improves connection speed and reliability

4. **Enable Paper Trading** (recommended for testing)
   - Go to **Bot Config** tab
   - Toggle "Paper Trading" ON
   - Start with virtual funds to test strategies

### Starting the Bot

1. **Configure Trading Settings**
   - Select your risk mode (Safe/Medium/High)
   - Set trade amount (start small!)
   - Configure take-profit and stop-loss

2. **Start Trading**
   - Click "Start Autotrading" button
   - Watch the Market Feed for new tokens
   - Monitor Active Trades for positions

3. **Monitor Performance**
   - Check Dashboard Stats for overall performance
   - Review Trade History for detailed logs
   - Use System Logs to see bot decisions

### Manual Controls

- **Sell Button**: Manually close any position
- **Stop Bot**: Pause trading at any time
- **Clear Trades**: Reset trade history (paper mode)

---

## 🎯 Detailed Strategy Breakdown

### 🏃 Runner Mode (Recommended)
This is the "set it and forget it" mode for most users. It trades less often but filters steadily for quality.
- **Entry:** Strict 4-Tier pass.
- **Exit:** Takes profit at 30%, but keeps a **Trailing Stop** active to catch moonshots.
- **Stop Loss:** Tight 10% to protect capital.

### 🎯 Sniper Mode
For those who believe "early bird gets the worm." Monitors for new contract creations and filters out obvious scams.
- **Entry:** Instant, as long as the contract is safe (Tier 0).
- **Exit:** Fast 50% take profit. Hit and run.
- **Stop Loss:** 15%.

### 🎰 Degen Mode
For when the market is irrational and you want to ride the hype.
- **Entry:** Momentum-based. If liquidity is pouring in, Degen buys.
- **Exit:** 100% Take Profit (doubles your money).
- **Stop Loss:** 25% (gives the token room to breathe).
- **Special Feature:** "Momentum Exit" - automatically sells if pressure drops.

---

## 🛡️ Safety Warning

### ⚠️ CRITICAL DISCLAIMERS

**This software is HIGH RISK. Use at your own risk.**

1. **Memecoin Trading is Extremely Risky**
   - 98.6% of Pump.fun tokens are scams/rugs
   - Even "Safe" mode can lose money
   - Only trade what you can afford to lose

2. **No Guarantees**
   - The bot cannot guarantee profits
   - Rug detection is not 100% accurate
   - Market conditions change rapidly

3. **Best Practices**
   - ✅ Start with paper trading
   - ✅ Use small amounts initially
   - ✅ Never invest more than you can lose
   - ✅ Monitor actively, don't set and forget
   - ✅ Keep private keys secure
   - ✅ Use a dedicated trading wallet

4. **The Developer is NOT Responsible**
   - For any financial losses
   - For bugs or errors in the software
   - For your trading decisions

### Security Notes

- **Private Keys**: Stored locally in browser, never sent to servers
- **API Keys**: Helius keys are stored locally, optional to use
- **Transactions**: All transactions are signed locally
- **No Backend**: This is a client-side application

---

## 📁 Project Structure

```
memevelocity/
├── app/
│   ├── page.tsx          # Main trading interface
│   ├── layout.tsx        # App layout
│   └── globals.css       # Global styles
├── components/
│   ├── LiveFeed.tsx      # Real-time token feed
│   ├── ActiveTrades.tsx  # Open positions dashboard
│   ├── BotControls.tsx   # Trading controls
│   ├── WalletManager.tsx # Wallet management
│   ├── TradeHistory.tsx  # Trade history log
│   └── DashboardStats.tsx # Performance stats
├── hooks/
│   └── usePumpTrader.ts  # Core trading logic
├── utils/
│   ├── rugDetector.ts    # Rug pull detection
│   ├── tokenAnalyzer.ts  # Token analysis
│   ├── enhancedAnalyzer.ts # Advanced analysis
│   ├── solanaManager.ts  # Solana RPC management
│   └── pumpPortal.ts     # Pump.fun API integration
└── README.md
```

---

## 🔧 Troubleshooting

### Market Feed Not Showing Tokens

- **Check Connection**: Look for "connected" status (green dot)
- **Helius Key**: Verify your Helius API key is valid
- **Low Activity**: Pump.fun may have low activity - this is normal
- **Console Logs**: Check browser console for connection errors

### Trades Not Executing

- **Wallet Balance**: Ensure you have enough SOL
- **Paper Trading**: Check if paper trading is enabled
- **Max Trades**: You may have hit the concurrent trade limit
- **Score Threshold**: Token may not meet your mode's requirements

### Price Updates Not Working

- **RPC Connection**: Check Helius key or public RPC status
- **Network Issues**: Try refreshing the page
- **Token Rugged**: Price may have dropped to zero (check logs)

### Performance Issues

- **Use Helius**: Public RPC is slower
- **Reduce Concurrent Trades**: Lower max trades for better performance
- **Close Old Tabs**: Multiple instances can slow things down

---

## 📚 Additional Documentation

- [Helius Setup Guide](./HELIUS_SETUP.md) - Detailed Helius configuration
- [Network Troubleshooting](./NETWORK_TROUBLESHOOTING.md) - Connection issues
- [Paper Trading Guide](./PAPER_TRADING_STATUS.md) - Paper trading details
- [Speed Trading Guide](./SPEED_TRADING_GUIDE.md) - High-frequency strategies

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

**Areas for Contribution:**
- Improved rug detection algorithms
- Additional trading strategies
- UI/UX improvements
- Performance optimizations
- Documentation improvements

---

## 📝 License

This project is provided as-is for educational and research purposes. Use at your own risk.

---

## 🙏 Acknowledgments

- Built for the Pump.fun ecosystem on Solana
- Uses [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/)
- Powered by [Next.js](https://nextjs.org/)
- Enhanced with [Helius RPC](https://helius.dev)

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/M1k3lee/memevelocity/issues)
- **Discussions**: [GitHub Discussions](https://github.com/M1k3lee/memevelocity/discussions)

---

<div align="center">

**⚠️ Remember: Only trade what you can afford to lose. Memecoin trading is extremely risky. ⚠️**

Made with ❤️ for the Solana community

</div>
