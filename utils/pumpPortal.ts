import { VersionedTransaction, Connection, Keypair, TransactionMessage } from "@solana/web3.js";
import bs58 from "bs58";

const TRADE_API_URL = "https://pumpportal.fun/api/trade-local";

export interface TradeParams {
    publicKey: string;
    action: "buy" | "sell";
    mint: string;
    amount: number; // SOL amount for buy, Token amount for sell
    denominatedInSol: "true" | "false";
    slippage: number;
    priorityFee: number;
    pool: "pump";
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

        const signature = await connection.sendTransaction(transaction, {
            skipPreflight: false,
            preflightCommitment: 'confirmed'
        });

        return signature;
    } catch (error) {
        console.error("Sign/Send Error:", error);
        throw error;
    }
};
