import { createPublicClient, createWalletClient, fallback, http, type Chain, type Transport } from 'viem';
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
  const transport = rpcTransport(env);
  const publicClient = createPublicClient({ chain, transport });
  if (!env.AGENT_PRIVATE_KEY) {
    return { chain, publicClient, walletClient: undefined, account: undefined };
  }
  const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY as `0x${string}`);
  const walletClient = createWalletClient({ chain, transport, account });
  return { chain, publicClient, walletClient, account };
}

export type Clients = ReturnType<typeof makeClients>;

/**
 * Availability: the configured RPC first, then any `RPC_FALLBACK_URLS`, then the
 * chain's public default. viem's fallback transport moves to the next endpoint
 * when one errors or times out, so a single flaky RPC does not take the wallet
 * down. Endpoints are all on the same (testnet) chain chosen above.
 */
export function rpcUrls(env: Pick<Env, 'RPC_URL' | 'RPC_FALLBACK_URLS'>): (string | undefined)[] {
  const extra = (env.RPC_FALLBACK_URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//.test(u));
  const urls: (string | undefined)[] = [env.RPC_URL, ...extra].filter(Boolean);
  // `undefined` means the chain's default public RPC; keep it as the last resort.
  urls.push(undefined);
  return [...new Set(urls)];
}

function rpcTransport(env: Env): Transport {
  const urls = rpcUrls(env);
  const transports = urls.map((u) => http(u, { timeout: 10_000, retryCount: 1 }));
  return transports.length === 1 ? transports[0]! : fallback(transports, { rank: false, retryCount: 1 });
}

export function explorerTx(chain: Chain, hash: string) {
  const base = chain.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : hash;
}
