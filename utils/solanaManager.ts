import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { createCloseAccountInstruction } from "@solana/spl-token";
import bs58 from "bs58";
import { calculateBondingCurveProgress, calculatePumpPrice } from "./pumpMath";

// Official Solana public endpoint for fallback/dev use. Production should use a private RPC.
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

// Validate Helius API key format
const isValidHeliusKey = (key: string): boolean => {
    if (!key || key.trim() === '') return false;
    const trimmed = key.trim();
    const invalidPatterns = ['admin', 'test', 'demo', 'key', 'placeholder'];
    const lowerKey = trimmed.toLowerCase();
    if (invalidPatterns.some(pattern => lowerKey.includes(pattern) && trimmed.length < 30)) {
        return false;
    }
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidPattern.test(trimmed) || trimmed.length >= 32;
};

export const createConnection = (heliusKey?: string) => {
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

type CacheEntry<T> = {
    value: T;
    expiresAt: number;
};

const tokenBalanceCache = new Map<string, CacheEntry<number>>();
const holderCountCache = new Map<string, CacheEntry<number | null>>();
const holderStatsCache = new Map<string, CacheEntry<any>>();
const pendingTokenBalances = new Map<string, Promise<number>>();
const pendingHolderCounts = new Map<string, Promise<number | null>>();
const pendingHolderStats = new Map<string, Promise<any>>();
const ZERO_TOKEN_BALANCE_CACHE_TTL_MS = 2000;
const TOKEN_BALANCE_CACHE_TTL_MS = 15000;

const getCachedValue = <T>(cache: Map<string, CacheEntry<T>>, key: string): { hit: boolean; value?: T } => {
    const entry = cache.get(key);
    if (!entry) return { hit: false };
    if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return { hit: false };
    }
    return { hit: true, value: entry.value };
};

const setCachedValue = <T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number) => {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
};

const withPendingRequest = async <T>(
    pending: Map<string, Promise<T>>,
    key: string,
    request: () => Promise<T>
): Promise<T> => {
    const existing = pending.get(key);
    if (existing) return existing;

    const next = request().finally(() => pending.delete(key));
    pending.set(key, next);
    return next;
};

export const setGlobalConnection = (newConn: Connection) => {
    connection = newConn;
};

export const clearTokenBalanceCache = (walletPubKey?: string, mintAddress?: string) => {
    const matches = (key: string) => {
        const [cachedWallet, cachedMint] = key.split(':');
        return (!walletPubKey || cachedWallet === walletPubKey) && (!mintAddress || cachedMint === mintAddress);
    };

    for (const key of [...tokenBalanceCache.keys()]) {
        if (matches(key)) {
            tokenBalanceCache.delete(key);
        }
    }

    for (const key of [...pendingTokenBalances.keys()]) {
        if (matches(key)) {
            pendingTokenBalances.delete(key);
        }
    }
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
        return null;
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
    const cacheKey = `${walletPubKey}:${mintAddress}`;
    const cached = getCachedValue(tokenBalanceCache, cacheKey);
    if (cached.hit) return cached.value ?? 0;

    if (isCircuitBroken()) return cached.value ?? 0;

    return withPendingRequest(pendingTokenBalances, cacheKey, async () => {
        try {
            const userPub = new PublicKey(walletPubKey);
            const accounts = await conn.getParsedTokenAccountsByOwner(userPub, { mint: new PublicKey(mintAddress) });

            if (accounts.value.length === 0) {
                setCachedValue(tokenBalanceCache, cacheKey, 0, ZERO_TOKEN_BALANCE_CACHE_TTL_MS);
                return 0;
            }

            let total = 0;
            for (const acc of accounts.value) {
                total += acc.account.data.parsed.info.tokenAmount.uiAmount;
            }

            setCachedValue(
                tokenBalanceCache,
                cacheKey,
                total,
                total > 0 ? TOKEN_BALANCE_CACHE_TTL_MS : ZERO_TOKEN_BALANCE_CACHE_TTL_MS
            );
            return total;
        } catch (error) {
            const errorMsg = String((error as any)?.message || error);
            if (errorMsg.includes('Invalid param: could not find mint')) {
                setCachedValue(tokenBalanceCache, cacheKey, 0, 5000);
                return 0;
            }

            handleRpcError('getTokenBalance', error);
            console.error("Error fetching token balance:", error);
            const fallback = cached.value ?? 0;
            setCachedValue(tokenBalanceCache, cacheKey, fallback, 5000);
            return fallback;
        }
    });
};

export const getHolderCount = async (mintAddress: string, conn: Connection = connection): Promise<number | null> => {
    const cached = getCachedValue(holderCountCache, mintAddress);
    if (cached.hit) return cached.value ?? null;

    if (isCircuitBroken()) return cached.value ?? null;

    return withPendingRequest(pendingHolderCounts, mintAddress, async () => {
        try {
            const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
            const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
            const fetchHolders = (async () => {
                const accounts = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
                    filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mintAddress } }]
                });
                return accounts.length;
            })();
            const result = await Promise.race([fetchHolders, timeout]);
            setCachedValue(holderCountCache, mintAddress, result, result === null ? 10000 : 45000);
            return result;
        } catch (error) {
            handleRpcError('getHolderCount', error);
            console.warn("Error fetching holder count:", error);
            setCachedValue(holderCountCache, mintAddress, null, 10000);
            return null;
        }
    });
};

// Rate limit and error tracking
const rateLimitCoolDowns = new Map<string, number>();
let globalRpcErrorCount = 0;
let lastGlobalErrorTime = 0;

const handleRpcError = (method: string, error: any) => {
    const errorMsg = String(error?.message || error);
    const isRateLimit = errorMsg.includes('429') || errorMsg.includes('Too Many Requests');
    const isAccessDenied = errorMsg.includes('403') || errorMsg.includes('Forbidden') || errorMsg.includes('Access denied');

    if (isRateLimit || isAccessDenied) {
        globalRpcErrorCount++;
        lastGlobalErrorTime = Date.now();
        console.warn(`[solanaManager] RPC ${isRateLimit ? 'Rate Limit' : 'Access Denied'} on ${method}. Total errors: ${globalRpcErrorCount}`);
    }
    return { isRateLimit, isAccessDenied };
};

const isCircuitBroken = () => {
    if (globalRpcErrorCount > 15 && (Date.now() - lastGlobalErrorTime) < 60000) return true;
    if ((Date.now() - lastGlobalErrorTime) > 120000) globalRpcErrorCount = 0;
    return false;
};

export const getPumpData = async (mintAddress: string, conn: Connection = connection) => {
    if (isCircuitBroken()) return null;
    const coolDownUntil = rateLimitCoolDowns.get(mintAddress) || 0;
    if (Date.now() < coolDownUntil) return null;

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

        const bondingCurveProgress = calculateBondingCurveProgress(vTokensInBondingCurve);

        rateLimitCoolDowns.delete(mintAddress);
        return { vTokensInBondingCurve, vSolInBondingCurve, tokenTotalSupply, bondingCurveProgress };
    } catch (e: any) {
        const { isRateLimit } = handleRpcError('getPumpData', e);
        if (isRateLimit) rateLimitCoolDowns.set(mintAddress, Date.now() + 15000);
        return null;
    }
};

export const getPumpPrice = async (mintAddress: string, conn: Connection = connection) => {
    const data = await getPumpData(mintAddress, conn);
    if (!data || data.vTokensInBondingCurve === 0) return 0;
    if (data.vSolInBondingCurve < 0.1) return 0;
    const price = calculatePumpPrice(data.vSolInBondingCurve, data.vTokensInBondingCurve);
    if (price < 0.000000001) return 0;
    return price;
};

export const metadataCache = new Map<string, { name: string, symbol: string, uri: string }>();

export const getTokenMetadata = async (mintAddress: string, heliusKey?: string): Promise<{ name: string, symbol: string, uri: string }> => {
    if (metadataCache.has(mintAddress)) return metadataCache.get(mintAddress)!;
    if (!heliusKey) return { name: "", symbol: "", uri: "" };

    if (isCircuitBroken()) return { name: "", symbol: "", uri: "" };
    const coolDownUntil = rateLimitCoolDowns.get(mintAddress) || 0;
    if (Date.now() < coolDownUntil) return { name: "", symbol: "", uri: "" };

    try {
        const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: "2.0", id: "get-asset", method: "getAsset", params: { id: mintAddress }
            })
        });

        if (response.status === 429) {
            handleRpcError('getTokenMetadata (429)', null);
            rateLimitCoolDowns.set(mintAddress, Date.now() + 30000);
            return { name: "", symbol: "", uri: "" };
        }
        if (response.status === 403) {
            handleRpcError('getTokenMetadata (403)', null);
            rateLimitCoolDowns.set(mintAddress, Date.now() + 60000);
            return { name: "", symbol: "", uri: "" };
        }

        const data = await response.json();
        if (data.result && data.result.content && data.result.content.metadata) {
            const meta = {
                name: data.result.content.metadata.name || "",
                symbol: data.result.content.metadata.symbol || "",
                uri: data.result.content.json_uri || ""
            };
            metadataCache.set(mintAddress, meta);
            return meta;
        }
    } catch (e) {
        console.error("Error fetching metadata:", e);
    }
    return { name: "", symbol: "", uri: "" };
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
    const cached = getCachedValue(holderStatsCache, mintAddress);
    if (cached.hit) return cached.value ?? null;

    if (isCircuitBroken()) return cached.value ?? null;

    return withPendingRequest(pendingHolderStats, mintAddress, async () => {
        try {
            const mint = new PublicKey(mintAddress);
            const largestAccounts = await conn.getTokenLargestAccounts(mint);
            if (!largestAccounts || !largestAccounts.value) {
                setCachedValue(holderStatsCache, mintAddress, null, 10000);
                return null;
            }

            const supplyResponse = await conn.getTokenSupply(mint);
            const totalSupply = supplyResponse.value.uiAmount || 0;
            const bondingCurve = getBondingCurveAddress(mintAddress).toBase58();
            const relevantAccounts = largestAccounts.value.slice(0, 15);

            const ownerEntries = await Promise.all(relevantAccounts.map(async (acc) => {
                try {
                    const accountInfo = await conn.getParsedAccountInfo(acc.address);
                    if (!accountInfo.value || typeof accountInfo.value.data === 'string') {
                        return [acc.address.toBase58(), null] as const;
                    }

                    const parsed = accountInfo.value.data as any;
                    return [acc.address.toBase58(), parsed.parsed?.info?.owner || null] as const;
                } catch {
                    return [acc.address.toBase58(), null] as const;
                }
            }));
            const ownerMap = new Map(ownerEntries);

            let top10Sum = 0;
            let whaleCount = 0;
            const userAccounts = relevantAccounts.filter(acc => ownerMap.get(acc.address.toBase58()) !== bondingCurve);
            const top10 = userAccounts.slice(0, 10);

            for (const acc of top10) {
                const amount = acc.uiAmount || 0;
                top10Sum += amount;
                if (totalSupply > 0 && (amount / totalSupply) > 0.01) whaleCount++;
            }

            const result = {
                top10Concentration: totalSupply > 0 ? (top10Sum / totalSupply) * 100 : 0,
                whaleCount,
                topHolders: top10,
                largestHolderPercentage: (top10.length > 0 && totalSupply > 0) ? (top10[0].uiAmount || 0) / totalSupply * 100 : 0,
                largestHolderOwner: top10.length > 0 ? (ownerMap.get(top10[0].address.toBase58()) || null) : null,
                totalSupply
            };

            setCachedValue(holderStatsCache, mintAddress, result, 45000);
            return result;
        } catch (e) {
            const errorMsg = String((e as any)?.message || e);
            if (errorMsg.includes('Invalid param: not a Token mint')) {
                setCachedValue(holderStatsCache, mintAddress, null, 30000);
                return null;
            }

            handleRpcError('getHolderStats', e);
            console.error("Error fetching holder stats:", e);
            setCachedValue(holderStatsCache, mintAddress, null, 10000);
            return null;
        }
    });
};

/**
 * Close any empty token accounts for the given mint so the ~0.00204 SOL of
 * account rent flows back to the wallet. Without this, every full round trip
 * silently leaves the rent behind — a fixed loss that dwarfed the take-profit
 * on small positions. Returns the number of accounts closed.
 */
export const closeEmptyTokenAccounts = async (
    owner: Keypair,
    mintAddress: string,
    conn: Connection = connection
): Promise<number> => {
    try {
        const accounts = await conn.getParsedTokenAccountsByOwner(owner.publicKey, {
            mint: new PublicKey(mintAddress)
        });

        const emptyAccounts = accounts.value.filter(
            (acc) => (acc.account.data.parsed.info.tokenAmount.uiAmount || 0) === 0
        );
        if (emptyAccounts.length === 0) return 0;

        const tx = new Transaction();
        for (const acc of emptyAccounts) {
            tx.add(createCloseAccountInstruction(acc.pubkey, owner.publicKey, owner.publicKey));
        }

        await sendAndConfirmTransaction(conn, tx, [owner], {
            commitment: 'confirmed',
            skipPreflight: false
        });
        return emptyAccounts.length;
    } catch (error) {
        // Rent recovery is opportunistic — never let it break the sell path.
        console.warn(`[closeEmptyTokenAccounts] failed for ${mintAddress}:`, (error as any)?.message || error);
        return 0;
    }
};

export const getConnection = () => connection;
