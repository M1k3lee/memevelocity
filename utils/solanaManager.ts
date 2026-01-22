import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";

// Default public node
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

// Validate Helius API key format
const isValidHeliusKey = (key: string): boolean => {
    if (!key || key.trim() === '') return false;
    const trimmed = key.trim();
    // Reject obvious placeholders
    const invalidPatterns = ['admin', 'test', 'demo', 'key', 'placeholder'];
    const lowerKey = trimmed.toLowerCase();
    if (invalidPatterns.some(pattern => lowerKey.includes(pattern) && trimmed.length < 30)) {
        return false;
    }
    // UUID format: 8-4-4-4-12 (36 chars total) or long hex string (32+ chars)
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidPattern.test(trimmed) || trimmed.length >= 32;
};

export const createConnection = (heliusKey?: string) => {
    // Only use Helius if key is valid, otherwise fall back to public RPC
    const useHelius = heliusKey && isValidHeliusKey(heliusKey);
    const url = useHelius ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : DEFAULT_RPC;
    if (useHelius) {
        console.log(`[createConnection] Using Helius RPC with key: ${heliusKey.substring(0, 8)}...`);
    } else {
        console.log(`[createConnection] Using public RPC (Helius key: ${heliusKey ? 'invalid' : 'not provided'})`);
    }
    return new Connection(url, "confirmed");
};

// Initial connection
let connection = createConnection();

export const setGlobalConnection = (newConn: Connection) => {
    connection = newConn;
};

export const generateWallet = () => {
    const keypair = Keypair.generate();
    return {
        publicKey: keypair.publicKey.toBase58(),
        privateKey: bs58.encode(keypair.secretKey),
        keypair: keypair
    };
};

export const getBalance = async (publicKeyString: string, conn: Connection = connection): Promise<number | null> => {
    try {
        const publicKey = new PublicKey(publicKeyString);
        const balance = await conn.getBalance(publicKey);
        return balance / LAMPORTS_PER_SOL;
    } catch (error) {
        console.warn("RPC Error fetching balance:", error);
        return null; // Return null instead of 0 to distinguish error from empty wallet
    }
};

export const recoverWallet = (privateKeyString: string) => {
    try {
        const secretKey = bs58.decode(privateKeyString);
        const keypair = Keypair.fromSecretKey(secretKey);
        return {
            publicKey: keypair.publicKey.toBase58(),
            privateKey: privateKeyString,
            keypair: keypair
        };
    } catch (err) {
        throw new Error("Invalid private key");
    }
};

export const getTokenBalance = async (walletPubKey: string, mintAddress: string, conn: Connection = connection) => {
    try {
        const filters = [
            {
                dataSize: 165, // ZIP-165 layout
            },
            {
                memcmp: {
                    offset: 32, // Owner offset
                    bytes: walletPubKey,
                },
            },
            {
                memcmp: {
                    offset: 0, // Mint offset
                    bytes: mintAddress,
                },
            }
        ];
        const userPub = new PublicKey(walletPubKey);
        const accounts = await conn.getParsedTokenAccountsByOwner(userPub, { mint: new PublicKey(mintAddress) });

        if (accounts.value.length === 0) return 0;

        // Sum up (should be only one usually)
        let total = 0;
        for (const acc of accounts.value) {
            total += acc.account.data.parsed.info.tokenAmount.uiAmount;
        }
        return total;
    } catch (error) {
        console.error("Error fetching token balance:", error);
        return 0;
    }
};

export const getHolderCount = async (mintAddress: string, conn: Connection = connection): Promise<number | null> => {
    try {
        const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

        // Create a timeout promise
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));

        const fetchHolders = (async () => {
            const accounts = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
                filters: [
                    { dataSize: 165 }, // Token Account layout size
                    { memcmp: { offset: 0, bytes: mintAddress } } // Mint address at offset 0
                ]
            });
            return accounts.length;
        })();

        // Race between fetch and timeout
        const result = await Promise.race([fetchHolders, timeout]);
        return result;
    } catch (error) {
        console.warn("Error fetching holder count:", error);
        return null;
    }
};



// Shared fallback connection to avoid overhead
const publicFallbackConnection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

// Track rate limit cooldowns per mint
const rateLimitCoolDowns = new Map<string, number>();

export const getPumpData = async (mintAddress: string, conn: Connection = connection) => {
    // Basic rate limit check
    const coolDownUntil = rateLimitCoolDowns.get(mintAddress) || 0;
    if (Date.now() < coolDownUntil) {
        return null; // Skip during cooldown
    }

    try {
        const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
        const mint = new PublicKey(mintAddress);
        const [bondingCurve] = PublicKey.findProgramAddressSync(
            [Buffer.from("bonding-curve"), mint.toBuffer()],
            PUMP_FUN_PROGRAM_ID
        );

        const account = await conn.getAccountInfo(bondingCurve);
        if (!account) return null;

        const vTokensInBondingCurve = Number(account.data.readBigUInt64LE(8));
        const vSolInBondingCurve = Number(account.data.readBigUInt64LE(16)) / LAMPORTS_PER_SOL;
        const tokenTotalSupply = Number(account.data.readBigUInt64LE(24));

        // Bonding curve progress calculation
        const bondingCurveProgress = Math.max(0, Math.min(100,
            100 - (((vTokensInBondingCurve - 206900000) * 100) / 793100000)
        ));

        // Clear cooldown on success
        rateLimitCoolDowns.delete(mintAddress);

        return { vTokensInBondingCurve, vSolInBondingCurve, tokenTotalSupply, bondingCurveProgress };
    } catch (e: any) {
        const errorMsg = e?.message || String(e);
        const isRateLimit = errorMsg.includes('429') || errorMsg.includes('Too Many Requests');
        const isAccessDenied = errorMsg.includes('403') || errorMsg.includes('Forbidden') || errorMsg.includes('Access denied');

        if (isRateLimit) {
            console.warn(`[getPumpData] Rate limit hit for ${mintAddress.substring(0, 8)}... Cooling down.`);
            // Apply 5s cooldown
            rateLimitCoolDowns.set(mintAddress, Date.now() + 5000);
        } else if (isAccessDenied) {
            console.warn(`[getPumpData] Access denied for ${mintAddress.substring(0, 8)}... - trying public RPC fallback`);
            try {
                // Use shared fallback connection instead of creating a new one
                const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
                const mint = new PublicKey(mintAddress);
                const [bondingCurve] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), mint.toBuffer()],
                    PUMP_FUN_PROGRAM_ID
                );
                const account = await publicFallbackConnection.getAccountInfo(bondingCurve);
                if (account) {
                    const vTokensInBondingCurve = Number(account.data.readBigUInt64LE(8));
                    const vSolInBondingCurve = Number(account.data.readBigUInt64LE(16)) / LAMPORTS_PER_SOL;
                    const tokenTotalSupply = Number(account.data.readBigUInt64LE(24));
                    const bondingCurveProgress = Math.max(0, Math.min(100,
                        100 - (((vTokensInBondingCurve - 206900000) * 100) / 793100000)
                    ));
                    return { vTokensInBondingCurve, vSolInBondingCurve, tokenTotalSupply, bondingCurveProgress };
                }
            } catch (fallbackError: any) {
                if (String(fallbackError).includes('429')) {
                    rateLimitCoolDowns.set(mintAddress, Date.now() + 10000); // Longer cooldown for fallback
                }
            }
        }
        return null;
    }
};

export const getPumpPrice = async (mintAddress: string, conn: Connection = connection) => {
    const data = await getPumpData(mintAddress, conn);
    if (!data || data.vTokensInBondingCurve === 0) return 0;

    // Safety check: If liquidity is too low, price might be unreliable
    if (data.vSolInBondingCurve < 0.1) {
        return 0; // Token likely rugged or invalid
    }

    // Account for 6 decimal places of pump.fun tokens
    const price = (data.vSolInBondingCurve / data.vTokensInBondingCurve) * 1000000;

    // Safety check: If price is unreasonably small, it might be a calculation error
    if (price < 0.000000001) {
        return 0; // Price too small, likely error or rug
    }

    return price;
};

const metadataCache = new Map<string, { name: string, symbol: string }>();

export const getTokenMetadata = async (mintAddress: string, heliusKey?: string) => {
    if (metadataCache.has(mintAddress)) return metadataCache.get(mintAddress)!;
    if (!heliusKey) return { name: "Unknown", symbol: "???" };

    // Check cooldown
    const coolDownUntil = rateLimitCoolDowns.get(mintAddress) || 0;
    if (Date.now() < coolDownUntil) return { name: "Cooling Down", symbol: "..." };

    try {
        const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: "get-asset",
                method: "getAsset",
                params: { id: mintAddress }
            })
        });

        // Handle 429 specifically for metadata
        if (response.status === 429) {
            rateLimitCoolDowns.set(mintAddress, Date.now() + 5000);
            return { name: "Rate Limited", symbol: "429" };
        }

        const data = await response.json();
        if (data.result && data.result.content && data.result.content.metadata) {
            const meta = {
                name: data.result.content.metadata.name || "Real Token",
                symbol: data.result.content.metadata.symbol || "REAL"
            };
            metadataCache.set(mintAddress, meta);
            return meta;
        }
    } catch (e) {
        console.error("Error fetching metadata:", e);
    }
    return { name: "Real Token", symbol: "REAL" };
};

export const getBondingCurveAddress = (mintAddress: string) => {
    const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    const mint = new PublicKey(mintAddress);
    const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mint.toBuffer()],
        PUMP_FUN_PROGRAM_ID
    );
    return bondingCurve;
};

export const getHolderStats = async (mintAddress: string, conn: Connection = connection) => {
    try {
        const mint = new PublicKey(mintAddress);
        const largestAccounts = await conn.getTokenLargestAccounts(mint);
        if (!largestAccounts || !largestAccounts.value) return null;

        const supplyResponse = await conn.getTokenSupply(mint);
        const totalSupply = supplyResponse.value.uiAmount || 0;

        // Get bonding curve address to exclude it
        const bondingCurve = getBondingCurveAddress(mintAddress).toBase58();

        // Calculate top 10 concentration (excluding bonding curve)
        let top10Sum = 0;
        let whaleCount = 0; // Holders with > 1%

        // Filter out bonding curve from top accounts
        const userAccounts = largestAccounts.value.filter(acc => acc.address.toString() !== bondingCurve);
        const top10 = userAccounts.slice(0, 10);

        for (const acc of top10) {
            const amount = acc.uiAmount || 0;
            top10Sum += amount;
            if (totalSupply > 0 && (amount / totalSupply) > 0.01) {
                whaleCount++;
            }
        }

        const top10Concentration = totalSupply > 0 ? (top10Sum / totalSupply) * 100 : 0;
        const largestHolderPercentage = (top10.length > 0 && totalSupply > 0) ? (top10[0].uiAmount || 0) / totalSupply * 100 : 0;

        return {
            top10Concentration,
            whaleCount,
            topHolders: top10,
            largestHolderPercentage
        };
    } catch (e) {
        console.error("Error fetching holder stats:", e);
        return null;
    }
};

export const getConnection = () => connection;
