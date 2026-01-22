"use client";

import React, { useState, useEffect } from 'react';
import { generateWallet, recoverWallet, getBalance } from '../utils/solanaManager';
import { QRCodeSVG } from 'qrcode.react';
import { Eye, EyeOff, Copy, RefreshCw, LogOut, Settings } from 'lucide-react';
import { Connection } from '@solana/web3.js';

interface WalletManagerProps {
    onWalletChange: (keypair: any | null) => void;
    onBalanceChange?: (balance: number) => void;
    connection: Connection;
    // Vault props
    vaultBalance?: number;
    profitProtectionEnabled?: boolean;
    profitProtectionPercent?: number;
    onWithdrawVault?: (amount: number) => void;
    onMoveVaultToTrading?: (amount: number) => void;
    onToggleProfitProtection?: () => void;
    onSetProfitProtectionPercent?: (percent: number) => void;
    onClearVault?: () => void;
    isDemo?: boolean;
}

export default function WalletManager({
    onWalletChange,
    onBalanceChange,
    connection,
    vaultBalance = 0,
    profitProtectionEnabled = true,
    profitProtectionPercent = 25,
    onWithdrawVault,
    onMoveVaultToTrading,
    onToggleProfitProtection,
    onSetProfitProtectionPercent,
    onClearVault,
    isDemo = false
}: WalletManagerProps) {
    const [wallet, setWallet] = useState<any>(null);
    const [balance, setBalance] = useState<number>(0);

    const [showKey, setShowKey] = useState(false);
    const [importKey, setImportKey] = useState("");
    const [view, setView] = useState<"create" | "view">("create");
    const [heliusKey, setHeliusKey] = useState("");

    // Validate Helius key format
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

    useEffect(() => {
        // Check local storage for wallet
        const savedKey = localStorage.getItem("pump_trader_priv");
        if (savedKey) {
            try {
                const restored = recoverWallet(savedKey);
                setWallet(restored);
                onWalletChange(restored);
                setView("view");
                refreshBalance(restored.publicKey);
            } catch (e) {
                console.error("Saved wallet invalid");
            }
        }

        // Load Helius API key from localStorage
        const savedHeliusKey = localStorage.getItem('helius_api_key');
        if (savedHeliusKey) {
            setHeliusKey(savedHeliusKey);
        }
    }, [connection]); // Re-run if connection changes

    useEffect(() => {
        if (wallet?.publicKey) {
            const interval = setInterval(() => {
                refreshBalance(wallet.publicKey);
            }, 10000);
            return () => clearInterval(interval);
        }
    }, [wallet?.publicKey, connection]);

    const refreshBalance = async (pubKey: string) => {
        try {
            const bal = await getBalance(pubKey, connection);
            if (bal !== null) {
                setBalance(bal);
                if (onBalanceChange) onBalanceChange(bal); // CRITICAL: Update parent state for trading logic
            }
        } catch (e) {
            console.error("Refresh balance failed:", e);
        }
    };

    useEffect(() => {
        if (balance > 0 && onBalanceChange) {
            onBalanceChange(balance);
        }
    }, [balance, onBalanceChange]);

    const handleCreate = () => {
        const newWallet = generateWallet();
        setWallet(newWallet);
        localStorage.setItem("pump_trader_priv", newWallet.privateKey);
        onWalletChange(newWallet);
        setView("view");
        refreshBalance(newWallet.publicKey);
    };

    const handleImport = () => {
        try {
            const restored = recoverWallet(importKey);
            setWallet(restored);
            localStorage.setItem("pump_trader_priv", restored.privateKey);
            onWalletChange(restored);
            setView("view");
            refreshBalance(restored.publicKey);
        } catch (e) {
            alert("Invalid Private Key (Base58 required)");
        }
    };

    const handleLogout = () => {
        localStorage.removeItem("pump_trader_priv");
        setWallet(null);
        onWalletChange(null);
        setView("create");
        setBalance(0);
    };

    if (view === "create") {
        return (
            <div className="glass-panel p-6 w-full max-w-md mx-auto animate-fade-in">
                <h2 className="text-2xl font-bold mb-4 glow-text">Connect Wallet</h2>
                <div className="space-y-4">
                    <button
                        onClick={handleCreate}
                        className="w-full btn-primary py-3 text-lg"
                    >
                        Create New Wallet
                    </button>

                    <div className="relative my-4">
                        <div className="absolute inset-0 flex items-center">
                            <span className="w-full border-t border-gray-700"></span>
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-[#0a0a0a] px-2 text-gray-500">Or Import</span>
                        </div>
                    </div>

                    <div className="flex gap-2">
                        <input
                            type="password"
                            placeholder="Paste Private Key (Base58)"
                            className="flex-1 bg-[#121212] border border-[#222] rounded px-3 py-2 text-white outline-none focus:border-[var(--primary)]"
                            value={importKey}
                            onChange={(e) => setImportKey(e.target.value)}
                        />
                        <button
                            onClick={handleImport}
                            className="bg-[#222] hover:bg-[#333] text-white px-4 rounded transition-colors"
                        >
                            Import
                        </button>
                    </div>
                </div>

                {/* Profit Protection Vault - Show in demo mode even without wallet */}
                {isDemo && (
                    <div className="border-t border-[#222] pt-4 mt-4">
                        <div className="bg-gradient-to-br from-purple-900/10 to-blue-900/10 border border-purple-500/20 rounded-lg p-4">
                            <div className="flex justify-between items-center mb-3">
                                <h3 className="text-sm font-bold text-purple-300 flex items-center gap-2">
                                    🔒 Profit Protection Vault
                                </h3>
                                <button
                                    onClick={onToggleProfitProtection}
                                    className={`text-xs px-3 py-1 rounded transition-colors ${profitProtectionEnabled
                                        ? 'bg-green-600 text-white'
                                        : 'bg-gray-600 text-gray-300'
                                        }`}
                                >
                                    {profitProtectionEnabled ? 'ON' : 'OFF'}
                                </button>
                            </div>

                            <div className="flex justify-between items-end mb-3">
                                <div>
                                    <p className="text-xs text-gray-400">Protected Balance</p>
                                    <p className="text-2xl font-bold text-purple-300">
                                        {vaultBalance.toFixed(4)} <span className="text-sm">SOL</span>
                                    </p>
                                </div>
                                <div className="text-right">
                                    <p className="text-xs text-gray-400">Protection Rate</p>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="range"
                                            min="0"
                                            max="50"
                                            step="5"
                                            value={profitProtectionPercent}
                                            onChange={(e) => onSetProfitProtectionPercent?.(parseInt(e.target.value))}
                                            className="w-20 h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                                            disabled={!profitProtectionEnabled}
                                        />
                                        <span className="text-sm font-bold text-purple-300 w-10">{profitProtectionPercent}%</span>
                                    </div>
                                </div>
                            </div>

                            {vaultBalance > 0 && (
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => {
                                            if (confirm("Are you sure you want to WIPE the vault? This cannot be undone (and is recommended before turning on real trading if it contains paper SOL).")) {
                                                onClearVault?.();
                                            }
                                        }}
                                        className="bg-red-600/20 hover:bg-red-600/30 text-red-300 text-[10px] px-2 py-2 rounded border border-red-500/30 transition-colors"
                                        title="Wipe Paper SOL"
                                    >
                                        🗑️ Wipe
                                    </button>
                                    <button
                                        onClick={() => {
                                            const amount = prompt(`Move to trading balance (Max: ${vaultBalance.toFixed(4)} SOL):`);
                                            if (amount && parseFloat(amount) > 0) {
                                                onMoveVaultToTrading?.(parseFloat(amount));
                                            }
                                        }}
                                        className="flex-1 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 text-xs py-2 rounded border border-blue-500/30 transition-colors"
                                    >
                                        📊 Move to Trading
                                    </button>
                                </div>
                            )}

                            <p className="text-[9px] text-gray-500 mt-2">
                                {profitProtectionEnabled
                                    ? `${profitProtectionPercent}% of each profit is automatically protected in this vault.`
                                    : 'Protection disabled - all profits go to trading balance.'}
                            </p>
                        </div>
                    </div>
                )}

                {/* Helius API Key - Show even when wallet not connected */}
                <div className="border-t border-[#222] pt-4 mt-4">
                    <h3 className="text-sm font-bold glow-text mb-3 flex items-center gap-2">
                        <Settings size={14} /> Helius API Key
                    </h3>
                    <div className="space-y-2">
                        <input
                            type="password"
                            value={heliusKey}
                            onChange={(e) => {
                                const newKey = e.target.value;
                                setHeliusKey(newKey);
                                // Always save to localStorage
                                if (newKey.trim() === '') {
                                    localStorage.removeItem('helius_api_key');
                                } else {
                                    localStorage.setItem('helius_api_key', newKey.trim());
                                }
                                // Trigger custom event so other components can sync
                                window.dispatchEvent(new CustomEvent('heliusKeyUpdated'));
                            }}
                            placeholder="Enter Helius API Key (or leave empty for public feed)"
                            className="w-full bg-[#121212] border border-[#222] rounded px-3 py-2 text-sm text-white outline-none focus:border-[var(--primary)]"
                        />
                        <p className="text-[10px] text-gray-500">
                            Get your free key at <a href="https://helius.dev" target="_blank" className="text-[var(--primary)] underline">helius.dev</a>
                            {heliusKey && !isValidHeliusKey(heliusKey) && (
                                <span className="block text-yellow-500 mt-1">⚠️ Invalid key format - using public feed</span>
                            )}
                            {heliusKey && isValidHeliusKey(heliusKey) && (
                                <span className="block text-green-500 mt-1">✓ Valid Helius key detected</span>
                            )}
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="glass-panel p-6 w-full animate-fade-in">
            <div className="flex justify-between items-start mb-4">
                <h2 className="text-xl font-bold glow-text">Wallet Active</h2>
                <button onClick={handleLogout} className="text-xs text-red-500 hover:text-red-400 flex items-center gap-1">
                    <LogOut size={12} /> Disconnect
                </button>
            </div>

            <div className="bg-[#121212] p-4 rounded-lg border border-[#222] mb-4 flex gap-4 items-center">
                <div className="bg-white p-1 rounded">
                    <QRCodeSVG value={wallet.publicKey} size={64} />
                </div>
                <div className="overflow-hidden">
                    <p className="text-xs text-gray-400 mb-1">Public Address</p>
                    <p className="text-sm font-mono text-[var(--secondary)] truncate w-full" title={wallet.publicKey}>
                        {wallet.publicKey.substring(0, 6)}...{wallet.publicKey.substring(wallet.publicKey.length - 6)}
                    </p>
                    <button
                        onClick={() => navigator.clipboard.writeText(wallet.publicKey)}
                        className="text-xs text-[var(--primary)] mt-1 flex items-center gap-1 hover:text-white"
                    >
                        <Copy size={12} /> Copy Address
                    </button>
                </div>
            </div>

            <div className="flex justify-between items-end mb-4">
                <div>
                    <p className="text-sm text-gray-400">Balance</p>
                    <p className="text-3xl font-bold text-white">{balance.toFixed(4)} <span className="text-sm text-[var(--primary)]">SOL</span></p>
                </div>
                <button
                    onClick={() => refreshBalance(wallet.publicKey)}
                    className="p-2 bg-[#222] rounded-full hover:bg-[var(--primary)] hover:text-white transition-all"
                >
                    <RefreshCw size={16} />
                </button>
            </div>

            {/* Profit Protection Vault */}
            <div className="bg-gradient-to-br from-purple-900/10 to-blue-900/10 border border-purple-500/20 rounded-lg p-4 mb-4">
                <div className="flex justify-between items-center mb-3">
                    <h3 className="text-sm font-bold text-purple-300 flex items-center gap-2">
                        🔒 Profit Protection Vault
                    </h3>
                    <button
                        onClick={onToggleProfitProtection}
                        className={`text-xs px-3 py-1 rounded transition-colors ${profitProtectionEnabled
                            ? 'bg-green-600 text-white'
                            : 'bg-gray-600 text-gray-300'
                            }`}
                    >
                        {profitProtectionEnabled ? 'ON' : 'OFF'}
                    </button>
                </div>

                <div className="flex justify-between items-end mb-3">
                    <div>
                        <p className="text-xs text-gray-400">Protected Balance</p>
                        <p className="text-2xl font-bold text-purple-300">
                            {vaultBalance.toFixed(4)} <span className="text-sm">SOL</span>
                        </p>
                    </div>
                    <div className="text-right">
                        <p className="text-xs text-gray-400">Protection Rate</p>
                        <div className="flex items-center gap-2">
                            <input
                                type="range"
                                min="0"
                                max="50"
                                step="5"
                                value={profitProtectionPercent}
                                onChange={(e) => onSetProfitProtectionPercent?.(parseInt(e.target.value))}
                                className="w-20 h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                                disabled={!profitProtectionEnabled}
                            />
                            <span className="text-sm font-bold text-purple-300 w-10">{profitProtectionPercent}%</span>
                        </div>
                    </div>
                </div>

                {vaultBalance > 0 && (
                    <div className="flex gap-2">
                        <button
                            onClick={() => {
                                if (confirm("Are you sure you want to WIPE the vault? This cannot be undone.")) {
                                    onClearVault?.();
                                }
                            }}
                            className="bg-red-600/20 hover:bg-red-600/30 text-red-300 text-[10px] px-2 py-2 rounded border border-red-500/30 transition-colors"
                            title="Wipe Vault"
                        >
                            🗑️ Wipe
                        </button>
                        <button
                            onClick={() => {
                                const amount = prompt(`Withdraw from vault (Max: ${vaultBalance.toFixed(4)} SOL):`);
                                if (amount && parseFloat(amount) > 0) {
                                    onWithdrawVault?.(parseFloat(amount));
                                }
                            }}
                            className="flex-1 bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 text-xs py-2 rounded border border-purple-500/30 transition-colors"
                        >
                            💰 Withdraw
                        </button>
                        {isDemo && (
                            <button
                                onClick={() => {
                                    const amount = prompt(`Move to trading balance (Max: ${vaultBalance.toFixed(4)} SOL):`);
                                    if (amount && parseFloat(amount) > 0) {
                                        onMoveVaultToTrading?.(parseFloat(amount));
                                    }
                                }}
                                className="flex-1 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 text-xs py-2 rounded border border-blue-500/30 transition-colors"
                            >
                                📊 Move to Trading
                            </button>
                        )}
                    </div>
                )}

                <p className="text-[9px] text-gray-500 mt-2">
                    {profitProtectionEnabled
                        ? `${profitProtectionPercent}% of each profit is automatically protected in this vault.`
                        : 'Protection disabled - all profits go to trading balance.'}
                </p>
            </div>

            <div className="border-t border-[#222] pt-4">
                <div className="flex justify-between items-center mb-2">
                    <p className="text-xs text-gray-400">Private Key (Keep Safe!)</p>
                    <button onClick={() => setShowKey(!showKey)} className="text-gray-400 hover:text-white">
                        {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                </div>
                <div className="bg-[#000] p-2 rounded border border-[#222] break-all font-mono text-xs text-gray-500 relative">
                    {showKey ? wallet.privateKey : "••••••••••••••••••••••••••••••••••••••••••••••••"}
                    {showKey && (
                        <button
                            onClick={() => navigator.clipboard.writeText(wallet.privateKey)}
                            className="absolute top-1 right-1 p-1 bg-[#222] rounded hover:text-white"
                        >
                            <Copy size={12} />
                        </button>
                    )}
                </div>
            </div>

            <div className="border-t border-[#222] pt-4 mt-4">
                <h3 className="text-sm font-bold glow-text mb-3 flex items-center gap-2">
                    <Settings size={14} /> Helius API Key
                </h3>
                <div className="space-y-2">
                    <input
                        type="password"
                        value={heliusKey}
                        onChange={(e) => {
                            const newKey = e.target.value;
                            setHeliusKey(newKey);
                            // Always save to localStorage
                            if (newKey.trim() === '') {
                                localStorage.removeItem('helius_api_key');
                            } else {
                                localStorage.setItem('helius_api_key', newKey.trim());
                            }
                            // Trigger custom event so other components can sync
                            window.dispatchEvent(new CustomEvent('heliusKeyUpdated'));
                        }}
                        placeholder="Enter Helius API Key (or leave empty for public feed)"
                        className="w-full bg-[#121212] border border-[#222] rounded px-3 py-2 text-sm text-white outline-none focus:border-[var(--primary)]"
                    />
                    <p className="text-[10px] text-gray-500">
                        Get your free key at <a href="https://helius.dev" target="_blank" className="text-[var(--primary)] underline">helius.dev</a>
                        {heliusKey && !isValidHeliusKey(heliusKey) && (
                            <span className="block text-yellow-500 mt-1">⚠️ Invalid key format - using public feed</span>
                        )}
                        {heliusKey && isValidHeliusKey(heliusKey) && (
                            <span className="block text-green-500 mt-1">✓ Valid Helius key detected</span>
                        )}
                    </p>
                </div>
            </div>

            <div className="border-t border-[#222] pt-4 mt-4">
                <h3 className="text-sm font-bold glow-text mb-2">Withdraw Funds</h3>
                <div className="space-y-2">
                    <input
                        placeholder="Recipient Address"
                        className="w-full bg-[#121212] border border-[#222] rounded px-2 py-1 text-sm text-white"
                        id="recipient"
                    />
                    <div className="flex gap-2">
                        <input
                            placeholder="Amount"
                            type="number"
                            className="flex-1 bg-[#121212] border border-[#222] rounded px-2 py-1 text-sm text-white"
                            id="amount"
                        />
                        <button
                            onClick={async () => {
                                const recipient = (document.getElementById('recipient') as HTMLInputElement).value;
                                const amount = (document.getElementById('amount') as HTMLInputElement).value;
                                if (!recipient || !amount) return;

                                try {
                                    const { SystemProgram, Transaction, PublicKey } = await import('@solana/web3.js');
                                    const transaction = new Transaction().add(
                                        SystemProgram.transfer({
                                            fromPubkey: wallet.keypair.publicKey,
                                            toPubkey: new PublicKey(recipient),
                                            lamports: parseFloat(amount) * 1000000000,
                                        })
                                    );

                                    const signature = await connection.sendTransaction(transaction, [wallet.keypair]);
                                    alert(`Sent! Tx: ${signature}`);
                                    refreshBalance(wallet.publicKey);
                                } catch (e: any) {
                                    alert("Transfer Failed: " + e.message);
                                }
                            }}
                            className="btn-primary text-xs px-3"
                        >
                            Send
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
