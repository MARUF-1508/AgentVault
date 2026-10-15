import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Creates a fresh TESTNET agent key and stores it in .env (never printed).
const path = '.env';
let env = existsSync(path) ? readFileSync(path, 'utf8') : readFileSync('.env.example', 'utf8');
const existing = env.match(/^AGENT_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m);
if (existing && !process.argv.includes('--force')) {
  console.log(`A key already exists in .env for ${privateKeyToAccount(existing[1] as `0x${string}`).address}. Use --force to replace it.`);
  process.exit(0);
}
const key = generatePrivateKey();
env = /^AGENT_PRIVATE_KEY=.*$/m.test(env) ? env.replace(/^AGENT_PRIVATE_KEY=.*$/m, `AGENT_PRIVATE_KEY=${key}`) : `${env}\nAGENT_PRIVATE_KEY=${key}\n`;
writeFileSync(path, env);
chmodSync(path, 0o600);
console.log(`New agent wallet: ${privateKeyToAccount(key).address}`);
console.log('Key saved to .env (chmod 600). Fund this address from a Base Sepolia faucet. Testnet only.');
