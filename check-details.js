const heliusKey = '79ab20be-047a-43c0-a0e1-2c0de3e0d4a5';
const wallet = '78t4tsvheSPPt1Qht7VQnRDQ382EqjHyWyrUzG3RcE1M';

async function checkDetails() {
    const url = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
    try {
        const sigResponse = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getSignaturesForAddress",
                params: [wallet, { limit: 5 }]
            })
        });
        const sigs = await sigResponse.json();

        for (const sig of sigs.result) {
            const txResponse = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "getTransaction",
                    params: [sig.signature, { maxSupportedTransactionVersion: 0 }]
                })
            });
            const tx = await txResponse.json();
            console.log('--- TX:', sig.signature, '---');
            if (tx.result && tx.result.meta) {
                console.log('Fee:', tx.result.meta.fee / 1e9, 'SOL');
                console.log('Compute Units Used:', tx.result.meta.computeUnitsConsumed);
                // Check if it's a pump fun trade
                const logs = tx.result.meta.logMessages || [];
                const isPump = logs.some(l => l.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'));
                console.log('Is PumpFun:', isPump);

                // Balance changes
                const pre = tx.result.meta.preBalances[0] / 1e9;
                const post = tx.result.meta.postBalances[0] / 1e9;
                console.log('Wallet SOL delta:', (post - pre).toFixed(6), 'SOL');

                // Check for token transfers
                const preTokens = tx.result.meta.preTokenBalances || [];
                const postTokens = tx.result.meta.postTokenBalances || [];
                if (postTokens.length > preTokens.length) {
                    console.log('Bought Token:', postTokens[postTokens.length - 1].mint);
                    console.log('Amount:', postTokens[postTokens.length - 1].uiTokenAmount.uiAmount);
                }
            } else {
                console.log('No metadata or failed to fetch');
            }
        }
    } catch (e) {
        console.error('Error:', e.message);
    }
}

checkDetails();
