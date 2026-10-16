import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { PolicySchema } from '../src/policy/types.js';
import { assessAddress, checkAddress } from '../src/risk/address.js';

const FRIEND = '0x1111111111111111111111111111111111111111';
const BLOCKED = '0x000000000000000000000000000000000000dEaD';
const OTHER = '0x2222222222222222222222222222222222222222';
// Shares the first and last 4 hex digits with FRIEND but is a different address.
const LOOKALIKE = `0x1111${'a'.repeat(32)}1111` as `0x${string}`;

const base = {
  version: 1 as const,
  chainId: 84532,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: {},
  recipients: { allowlist: { friend: FRIEND }, denylist: [] },
  approvals: { allowUnlimited: false, spenderAllowlist: {} },
  rateLimit: { maxTxPerHour: 5 },
};

const policy = PolicySchema.parse({
  ...base,
  risk: {
    maxActionPctOfPortfolio: 50,
    contractRecipients: 'confirm',
    blocklist: [BLOCKED],
    lookalike: { enabled: true, prefix: 4, suffix: 4 },
  },
});

describe('address risk (pure)', () => {
  it('flags an address on the local block list', () => {
    expect(assessAddress(BLOCKED, policy)).toMatchObject({ onBlocklist: true });
  });

  it('flags a lookalike of an allowlisted address (address poisoning)', () => {
    const r = assessAddress(LOOKALIKE, policy);
    expect(r.onBlocklist).toBe(false);
    expect(r.lookalikeOf?.toLowerCase()).toBe(FRIEND.toLowerCase());
  });

  it('does not flag the allowlisted address itself', () => {
    expect(assessAddress(FRIEND, policy).lookalikeOf).toBeUndefined();
  });

  it('does not flag an unrelated address', () => {
    expect(assessAddress(OTHER, policy).lookalikeOf).toBeUndefined();
  });

  it('respects lookalike detection being switched off', () => {
    const off = PolicySchema.parse({ ...base, risk: { lookalike: { enabled: false } } });
    expect(assessAddress(LOOKALIKE, off).lookalikeOf).toBeUndefined();
  });
});

const clientReturning = (code: unknown) => ({ getCode: async () => code }) as unknown as PublicClient;

describe('address risk (chain)', () => {
  it('detects a contract recipient (it has code)', async () => {
    expect((await checkAddress(clientReturning('0x60806040'), policy, FRIEND)).isContract).toBe(true);
  });

  it('treats an ordinary wallet (no code) as an EOA', async () => {
    expect((await checkAddress(clientReturning('0x'), policy, FRIEND)).isContract).toBe(false);
  });

  it('fails closed (treated as a contract) when the RPC cannot answer', async () => {
    const client = {
      getCode: async () => {
        throw new Error('rpc down');
      },
    } as unknown as PublicClient;
    expect((await checkAddress(client, policy, FRIEND)).isContract).toBe(true);
  });
});
