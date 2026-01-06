const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
const priv = '4U2w4bMJHtR3eSFgTAMogyzVSXNdWp8ooWQ5tBbF7jr6PYRuDYELPPmph34fcvTmpLxwu74Z1W4XMXx55DFzHcaj';
try {
    const key = Keypair.fromSecretKey(bs58.decode(priv));
    console.log('PublicKey:', key.publicKey.toBase58());
} catch (e) {
    console.error('Error:', e.message);
}
