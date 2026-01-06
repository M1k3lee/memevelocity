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
- 🎯 **Multiple Trading Strategies**: Safe, Medium, High-Risk, and custom modes
- 🔄 **Automated Exit Strategies**: Take-profit, stop-loss, trailing stops, and momentum-based exits
- 📈 **Live Portfolio Tracking**: Real-time PnL, trade history, and performance statistics

---

## ✨ Features

### 🎮 Trading Modes

- **Safe Mode** (Score ≥65): Conservative approach with strict filtering
  - High liquidity requirements
  - Strong contract security checks
  - Early profit-taking (20% default)
  
- **Medium Mode** (Score ≥50): Balanced risk/reward
  - Moderate filtering
  - Flexible exit strategies
  
- **High-Risk Mode** (Score ≥40): Aggressive early entry
  - Fast-track for very new tokens (<60s)
  - Higher momentum requirements
  - Still protected by rug detection

- **First Buyer Mode**: Targets tokens with strong initial buyer activity
- **Scalp Mode**: Quick in-and-out trades for small profits

### 🛡️ Rug Detection System

The bot includes a sophisticated multi-layer rug detection system:

1. **Quick Checks**: Fast pattern matching for obvious scams
   - Suspicious name patterns
   - Duplicate name detection (catches copycat scams)
   - Basic metadata validation

2. **Advanced Analysis**: Deep token inspection
   - Contract security analysis
   - Holder distribution checks
   - Liquidity pattern analysis
   - Bonding curve progress monitoring
   - Historical trade pattern detection

3. **Real-time Monitoring**: Continuous protection
   - Immediate exit on rapid price drops (>99.99%)
   - Stop-loss triggers
   - Liquidity drain detection

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

- **Trading Strategy**: Select Safe/Medium/High-Risk/First/Scalp
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

## 🎯 Trading Strategies Explained

### Safe Mode
**Best for**: Conservative traders, larger positions
- **Score Threshold**: 65+ (55+ in paper mode)
- **Focus**: High-quality tokens with strong fundamentals
- **Exit**: Early profit-taking, tight stop-loss
- **Risk**: Lower, but still significant in memecoin market

### Medium Mode
**Best for**: Balanced approach
- **Score Threshold**: 50+ (40+ in paper mode)
- **Focus**: Good tokens with moderate risk
- **Exit**: Flexible strategies
- **Risk**: Moderate

### High-Risk Mode
**Best for**: Experienced traders, small positions
- **Score Threshold**: 40+ (30+ in paper mode)
- **Focus**: Very early entry (<60s old tokens)
- **Fast Track**: Tokens with strong momentum (>1.5 SOL/min)
- **Exit**: Aggressive, but still protected by rug detection
- **Risk**: High - only use small amounts!

### First Buyer Mode
**Best for**: Catching tokens with strong initial interest
- **Focus**: Tokens with significant first buyer activity
- **Entry**: Early, based on initial momentum

### Scalp Mode
**Best for**: Quick profits, high frequency
- **Focus**: Small, quick gains
- **Exit**: Fast, tight stops

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
