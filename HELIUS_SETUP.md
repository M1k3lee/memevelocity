# Quick Setup: Helius RPC for Real Data

## Get Your Free API Key (Do This Now)

1. Go to: https://helius.dev
2. Click "Start Building" or "Sign Up"
3. Create a free account
4. Go to Dashboard → Create New Project
5. Select "Mainnet" network
6. Copy your API key (looks like: `abc123-def456-ghi789`)

## Paste Your API Key Here

Once you have it, replace `YOUR_HELIUS_API_KEY_HERE` in the next step.

Your Helius WebSocket URL will be:
```
wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY_HERE
```

## Why Helius?

- ✅ Free tier: 100,000 requests/day
- ✅ WebSocket support for real-time data
- ✅ Enhanced APIs for Solana programs
- ✅ Better reliability than public RPCs
- ✅ Can monitor pump.fun program directly
- ✅ No geo-blocking issues

## Next Steps

After getting your API key, I'll update the app to:
1. Connect to Helius WebSocket
2. Subscribe to pump.fun program (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P)
3. Parse new token creation events
4. Feed real data to Paper Trading

This will give you 100% real market data for testing!
