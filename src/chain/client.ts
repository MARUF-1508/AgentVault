import { createPublicClient, createWalletClient, http, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, sepolia } from 'viem/chains';
import type { Env } from '../config.js';

const CHAINS: Record<Env['CHAIN'], Chain> = {
  'base-sepolia': baseSepolia,
  sepolia,
};

export function makeClients(env: Env) {
  const chain = CHAINS[env.CHAIN];
  if (!chain.testnet && env.ALLOW_MAINNET !== 'true') {
    throw new Error(`Refusing to run on mainnet chain ${chain.name}. Set ALLOW_MAINNET=true if you really mean it.`);
  }
  const transport = http(env.RPC_URL);
  const publicClient = createPublicClient({ chain, transport });
  if (!env.AGENT_PRIVATE_KEY) {
    return { chain, publicClient, walletClient: undefined, account: undefined };
  }
  const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY as `0x${string}`);
  const walletClient = createWalletClient({ chain, transport, account });
  return { chain, publicClient, walletClient, account };
}

export type Clients = ReturnType<typeof makeClients>;

export function explorerTx(chain: Chain, hash: string) {
  const base = chain.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : hash;
}
