import { describe, expect, it } from 'vitest';
import { parseEther, parseUnits } from 'viem';
import { evaluate } from '../src/policy/engine.js';
import { PolicySchema, type SpendState } from '../src/policy/types.js';

const FRIEND = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x2222222222222222222222222222222222222222';
const DEX = '0x3333333333333333333333333333333333333333';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const CHAIN = 84532;

const policy = PolicySchema.parse({
  version: 1,
  chainId: CHAIN,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: {
    USDC: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, autoMaxPerTx: '1', hardMaxPerTx: '10', dailyBudget: '25' },
  },
  recipients: { allowlist: { friend: FRIEND }, denylist: [DEAD] },
  approvals: { allowUnlimited: false, spenderAllowlist: { dex: DEX } },
  rateLimit: { maxTxPerHour: 5 },
});

const fresh = (): SpendState => ({ spentToday: {}, txLastHour: 0, paused: false });

describe('policy engine: tiers', () => {
  it('T1 auto: small transfer to an allowlisted recipient', () => {
    const d = evaluate({ kind: 'native_transfer', to: FRIEND, amount: '0.0005' }, policy, fresh(), CHAIN);
    expect(d.tier).toBe('T1_AUTO');
    expect(d.amountBase).toBe(parseEther('0.0005'));
  });

  it('T2 confirm: new recipient', () => {
    const d = evaluate({ kind: 'native_transfer', to: STRANGER, amount: '0.0005' }, policy, fresh(), CHAIN);
    expect(d.tier).toBe('T2_CONFIRM');
    expect(d.reasons.join()).toMatch(/new recipient/);
  });

  it('T2 confirm: above auto limit but under hard cap', () => {
    const d = evaluate({ kind: 'native_transfer', to: FRIEND, amount: '0.005' }, policy, fresh(), CHAIN);
    expect(d.tier).toBe('T2_CONFIRM');
  });

  it('T3 deny: above hard cap even for a known recipient', () => {
    const d = evaluate({ kind: 'native_transfer', to: FRIEND, amount: '0.5' }, policy, fresh(), CHAIN);
    expect(d.tier).toBe('T3_DENY');
  });

  it('address matching is case-insensitive (checksum vs lowercase)', () => {
    const d = evaluate({ kind: 'native_transfer', to: DEAD.toLowerCase() as `0x${string}`, amount: '0.0001' }, policy, fresh(), CHAIN);
    expect(d.tier).toBe('T3_DENY');
  });
});

describe('policy engine: risk controls', () => {
  it('denies when the daily budget would be exceeded', () => {
    const state = { ...fresh(), spentToday: { ETH: parseEther('0.0195') } };
    const d = evaluate({ kind: 'native_transfer', to: FRIEND, amount: '0.001' }, policy, state, CHAIN);
    expect(d.tier).toBe('T3_DENY');
    expect(d.reasons.join()).toMatch(/Daily budget/);
  });

  it('budgets are per asset', () => {
    const state = { ...fresh(), spentToday: { ETH: parseEther('0.02') } };
    const d = evaluate({ kind: 'erc20_transfer', token: 'usdc', to: FRIEND, amount: '0.5' }, policy, state, CHAIN);
    expect(d.tier).toBe('T1_AUTO');
    expect(d.amountBase).toBe(parseUnits('0.5', 6));
  });

  it('denies everything when paused (kill switch)', () => {
    const d = evaluate({ kind: 'native_transfer', to: FRIEND, amount: '0.0001' }, policy, { ...fresh(), paused: true }, CHAIN);
    expect(d.tier).toBe('T3_DENY');
  });

  it('denies on chain mismatch', () => {
    const d = evaluate({ kind: 'native_transfer', to: FRIEND, amount: '0.0001' }, policy, fresh(), 1);
    expect(d.tier).toBe('T3_DENY');
  });

  it('denies over the hourly rate limit', () => {
    const d = evaluate({ kind: 'native_transfer', to: FRIEND, amount: '0.0001' }, policy, { ...fresh(), txLastHour: 5 }, CHAIN);
    expect(d.tier).toBe('T3_DENY');
  });

  it('denies unknown tokens', () => {
    const d = evaluate({ kind: 'erc20_transfer', token: 'SCAM', to: FRIEND, amount: '1' }, policy, fresh(), CHAIN);
    expect(d.tier).toBe('T3_DENY');
  });

  it('denies zero and malformed amounts', () => {
    expect(evaluate({ kind: 'native_transfer', to: FRIEND, amount: '0' }, policy, fresh(), CHAIN).tier).toBe('T3_DENY');
    expect(evaluate({ kind: 'erc20_transfer', token: 'USDC', to: FRIEND, amount: '0.0000001' }, policy, fresh(), CHAIN).tier).toBe('T3_DENY');
  });
});

describe('policy engine: approvals', () => {
  it('denies unlimited approvals', () => {
    const d = evaluate({ kind: 'erc20_approve', token: 'USDC', spender: DEX, amount: 'unlimited' }, policy, fresh(), CHAIN);
    expect(d.tier).toBe('T3_DENY');
  });

  it('denies approvals to non-allowlisted spenders', () => {
    const d = evaluate({ kind: 'erc20_approve', token: 'USDC', spender: STRANGER, amount: '1' }, policy, fresh(), CHAIN);
    expect(d.tier).toBe('T3_DENY');
  });

  it('allows a small bounded approval to an allowlisted spender', () => {
    const d = evaluate({ kind: 'erc20_approve', token: 'USDC', spender: DEX, amount: '1' }, policy, fresh(), CHAIN);
    expect(d.tier).toBe('T1_AUTO');
  });
});
