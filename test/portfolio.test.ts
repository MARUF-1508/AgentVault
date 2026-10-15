import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import type { Clients } from '../src/chain/client.js';
import { PolicySchema } from '../src/policy/types.js';
import { getPortfolio } from '../src/portfolio/portfolio.js';

const ADDRESS = '0x4785Dca37A242F3D80f844CB0b143A687008a2B5';

const basePolicy = {
  version: 1 as const,
  chainId: 84532,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: {
    USDC: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, autoMaxPerTx: '1', hardMaxPerTx: '10', dailyBudget: '25' },
  },
  recipients: { allowlist: {}, denylist: [] },
  approvals: { allowUnlimited: false, spenderAllowlist: {} },
  rateLimit: { maxTxPerHour: 5 },
};

type ReadArgs = { functionName: string };

function mockClients(read: (a: ReadArgs) => unknown): Clients {
  return {
    publicClient: {
      getBalance: async () => parseEther('1'),
      readContract: async (a: ReadArgs) => read(a),
    },
    account: { address: ADDRESS },
    chain: { id: 84532, name: 'Base Sepolia' },
  } as unknown as Clients;
}

describe('portfolio view', () => {
  it('values native and token balances from the labelled testnet price table', async () => {
    const policy = PolicySchema.parse({
      ...basePolicy,
      prices: { ETH: { fallbackUsd: '2000' }, USDC: { fallbackUsd: '1' } },
    });
    const clients = mockClients((a) => (a.functionName === 'balanceOf' ? 5_000_000n : 0n));
    const p = await getPortfolio(clients, policy);

    expect(p.address).toBe(ADDRESS);
    expect(p.holdings.map((h) => [h.asset, h.balance])).toEqual([
      ['ETH', '1'],
      ['USDC', '5'],
    ]);
    expect(p.holdings[0]!.priceSource).toBe('fixed-testnet-table');
    expect(p.holdings[1]).toMatchObject({ asset: 'USDC', balance: '5', usdValue: '5' });
    expect(p.totalUsd).toBe('2005');
  });

  it('prefers a configured Chainlink feed and labels the source', async () => {
    const policy = PolicySchema.parse({
      ...basePolicy,
      prices: {
        ETH: { chainlinkFeed: '0x0000000000000000000000000000000000000fEE', fallbackUsd: '2000' },
        USDC: { fallbackUsd: '1' },
      },
    });
    const clients = mockClients((a) => {
      if (a.functionName === 'balanceOf') return 5_000_000n;
      if (a.functionName === 'decimals') return 8;
      if (a.functionName === 'latestRoundData') return [1n, 3000_00000000n, 0n, 0n, 1n];
      return 0n;
    });
    const p = await getPortfolio(clients, policy);

    expect(p.holdings[0]).toMatchObject({ asset: 'ETH', usdPrice: '3000', priceSource: 'chainlink' });
    expect(p.totalUsd).toBe('3005');
  });

  it('falls back when the oracle read fails', async () => {
    const policy = PolicySchema.parse({
      ...basePolicy,
      prices: { ETH: { chainlinkFeed: '0x0000000000000000000000000000000000000fEE', fallbackUsd: '2000' }, USDC: { fallbackUsd: '1' } },
    });
    const clients = mockClients((a) => {
      if (a.functionName === 'latestRoundData') throw new Error('oracle down');
      if (a.functionName === 'balanceOf') return 0n;
      return 8;
    });
    const p = await getPortfolio(clients, policy);
    expect(p.holdings[0]!.priceSource).toBe('fixed-testnet-table');
  });

  it('returns an empty portfolio without a wallet key', async () => {
    const policy = PolicySchema.parse({ ...basePolicy, prices: { ETH: { fallbackUsd: '2000' } } });
    const clients = { publicClient: {}, account: undefined, chain: { id: 84532, name: 'Base Sepolia' } } as unknown as Clients;
    const p = await getPortfolio(clients, policy);
    expect(p.address).toBeNull();
    expect(p.holdings).toEqual([]);
    expect(p.totalUsd).toBe('0');
  });
});
