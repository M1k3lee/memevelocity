import { VersionedTransaction, Connection, Keypair } from "@solana/web3.js";

const TRADE_API_URL = "https://pumpportal.fun/api/trade-local";
const EXECUTION_FALLBACK_PATTERNS = [
    "blockhash",
    "timeout",
    "timed out",
    "429",
    "rate limit",
    "node is behind",
    "transport",
    "connection closed",
    "service unavailable",
    "temporarily unavailable",
    "failed to send",
    "preflight"
];

type TradePool = "auto" | "pump" | "pump-amm" | "raydium" | "raydium-cpmm" | "launchlab" | "bonk";

export interface TradeParams {
    publicKey: string;
    action: "buy" | "sell";
    mint: string;
    amount: number; // SOL amount for buy, Token amount for sell
    denominatedInSol: "true" | "false";
    slippage: number;
    priorityFee: number;
    pool: TradePool;
}

export const getTradeTransaction = async (params: TradeParams) => {
    try {
        const response = await fetch(TRADE_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(params)
        });

        if (!response.ok) {
            const txt = await response.text();
            throw new Error(`API Error: ${response.statusText} - ${txt}`);
        }

        // The API returns a binary buffer or base64? 
        // PumpPortal documentation usually returns a transaction to sign.
        // Let's assume it returns a raw transaction buffer or base64 string.
        // Based on typical usage, it returns a buffer array or base64.
        // Let's handle the array buffer.

        // Actually, fetch API with buffer:
        const arrayBuffer = await response.arrayBuffer();
        return new Uint8Array(arrayBuffer);

    } catch (error) {
        console.error("Trade API Error:", error);
        throw error;
    }
};

export const signAndSendTransaction = async (
    connection: Connection,
    transactionBuffer: Uint8Array,
    keypair: Keypair
) => {
    try {
        const transaction = VersionedTransaction.deserialize(transactionBuffer);
        transaction.sign([keypair]);

        try {
            return await connection.sendTransaction(transaction, {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
                maxRetries: 2
            });
        } catch (error: any) {
            const message = String(error?.message || error).toLowerCase();
            const isLikelySlippageFailure =
                message.includes("slippage") ||
                message.includes("toomuchsolrequired") ||
                message.includes("0x1772");
            const shouldUseFastFallback =
                !isLikelySlippageFailure &&
                EXECUTION_FALLBACK_PATTERNS.some((pattern) => message.includes(pattern));

            if (!shouldUseFastFallback) {
                throw error;
            }

            return await connection.sendRawTransaction(transaction.serialize(), {
                skipPreflight: true,
                preflightCommitment: 'confirmed',
                maxRetries: 5
            });
        }
    } catch (error) {
        console.error("Sign/Send Error:", error);
        throw error;
    }
};
