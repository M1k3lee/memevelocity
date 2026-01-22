import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";

// Default to a known stable endpoint instead of the public node which 403s frequently
const DEFAULT_RPC = "https://solana-api.projectserum.com";

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
    try {
        const userPub = new PublicKey(walletPubKey);
        const accounts = await conn.getParsedTokenAccountsByOwner(userPub, { mint: new PublicKey(mintAddress) });

        if (accounts.value.length === 0) return 0;
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
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
        const fetchHolders = (async () => {
            const accounts = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
                filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mintAddress } }]
            });
            return accounts.length;
        })();
        const result = await Promise.race([fetchHolders, timeout]);
        return result;
    } catch (error) {
        console.warn("Error fetching holder count:", error);
        return null;
    }
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

        const bondingCurveProgress = Math.max(0, Math.min(100,
            100 - (((vTokensInBondingCurve - 206900000) * 100) / 793100000)
        ));

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
    const price = (data.vSolInBondingCurve / data.vTokensInBondingCurve) * 1000000;
    if (price < 0.000000001) return 0;
    return price;
};

export const metadataCache = new Map<string, { name: string, symbol: string }>();

export const getTokenMetadata = async (mintAddress: string, heliusKey?: string) => {
    if (metadataCache.has(mintAddress)) return metadataCache.get(mintAddress)!;
    if (!heliusKey) return { name: "Unknown", symbol: "???" };

    if (isCircuitBroken()) return { name: "RPC Blocked", symbol: "BLOCK" };
    const coolDownUntil = rateLimitCoolDowns.get(mintAddress) || 0;
    if (Date.now() < coolDownUntil) return { name: "Cooling Down", symbol: "..." };

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
            return { name: "Rate Limited", symbol: "429" };
        }
        if (response.status === 403) {
            handleRpcError('getTokenMetadata (403)', null);
            rateLimitCoolDowns.set(mintAddress, Date.now() + 60000);
            return { name: "Forbidden", symbol: "403" };
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
        const bondingCurve = getBondingCurveAddress(mintAddress).toBase58();

        let top10Sum = 0;
        let whaleCount = 0;
        const userAccounts = largestAccounts.value.filter(acc => acc.address.toString() !== bondingCurve);
        const top10 = userAccounts.slice(0, 10);

        for (const acc of top10) {
            const amount = acc.uiAmount || 0;
            top10Sum += amount;
            if (totalSupply > 0 && (amount / totalSupply) > 0.01) whaleCount++;
        }

        const top10Concentration = totalSupply > 0 ? (top10Sum / totalSupply) * 100 : 0;
        const largestHolderPercentage = (top10.length > 0 && totalSupply > 0) ? (top10[0].uiAmount || 0) / totalSupply * 100 : 0;

        return { top10Concentration, whaleCount, topHolders: top10, largestHolderPercentage };
    } catch (e) {
        console.error("Error fetching holder stats:", e);
        return null;
    }
};

export const getConnection = () => connection;
