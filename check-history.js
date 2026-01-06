const heliusKey = '79ab20be-047a-43c0-a0e1-2c0de3e0d4a5';
const wallet = '78t4tsvheSPPt1Qht7VQnRDQ382EqjHyWyrUzG3RcE1M';

async function checkHistory() {
    const url = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getSignaturesForAddress",
                params: [wallet, { limit: 10 }]
            })
        });
        const data = await response.json();
        console.log('History:', JSON.stringify(data.result, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

checkHistory();
