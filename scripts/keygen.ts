import { writeAgentKey } from '../src/chain/keygen.js';

// Creates a fresh TESTNET agent key and stores it in .env (never printed).
const r = writeAgentKey('.env', { force: process.argv.includes('--force'), fallbackPath: '.env.example' });
if (!r.replaced) {
  console.log(`A key already exists in .env for ${r.address}. Use --force to replace it.`);
  process.exit(0);
}
console.log(`New agent wallet: ${r.address}`);
console.log('Key saved to .env (chmod 600). Fund this address from a Base Sepolia faucet. Testnet only.');
