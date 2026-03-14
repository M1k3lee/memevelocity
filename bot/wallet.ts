import { createConnection, getBalance } from '../utils/solanaManager';
import { loadRunnerConfig, parseConfiguredWallet } from './config';

async function main() {
    const config = loadRunnerConfig();
    if (!config.walletSecret) {
        throw new Error('Set TRADER_PRIVATE_KEY before running bot:wallet');
    }

    const wallet = parseConfiguredWallet(config.walletSecret);
    const connection = createConnection(config.heliusKey);
    const balance = await getBalance(wallet.publicKey.toBase58(), connection);

    console.log(`Wallet address: ${wallet.publicKey.toBase58()}`);
    console.log(`Balance: ${balance === null ? 'unavailable' : `${balance.toFixed(4)} SOL`}`);
    console.log(`Dry run: ${config.dryRun ? 'true' : 'false'}`);
    console.log(`State file: ${config.statePath}`);
    console.log('Funding flow: send SOL to the wallet address above from your main wallet, wait for confirmation, then start the runner.');
    console.log('Operational advice: keep this wallet dedicated to the bot and start with an amount you are prepared to lose.');
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
