import { describe, expect, it } from 'vitest';
import { parseEther, parseUnits } from 'viem';
import { evaluate } from '../src/policy/engine.js';
import { PolicySchema, type Intent, type SpendState } from '../src/policy/types.js';

const FRIEND = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x2222222222222222222222222222222222222222';
const DEX = '0x3333333333333333333333333333333333333333';
const QUOTER = '0x4444444444444444444444444444444444444444';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const CHAIN = 84532;

const policy = PolicySchema.parse({
  version: 1,
  chainId: CHAIN,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: {
    USDC: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, autoMaxPerTx: '1', hardMaxPerTx: '10', dailyBudget: '25' },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  },
  recipients: { allowlist: { friend: FRIEND }, denylist: [DEAD] },
  approvals: { allowUnlimited: false, spenderAllowlist: { dex: DEX } },
  swap: { router: DEX, quoter: QUOTER, feeTier: 3000, maxSlippageBps: 100, autoMaxSlippageBps: 50 },
  prices: { ETH: { fallbackUsd: '2000' }, WETH: { fallbackUsd: '2000' }, USDC: { fallbackUsd: '1' } },
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

describe('policy engine: swaps', () => {
  const quote = { amountOut: parseUnits('0.0002', 18) }; // 0.5 USDC -> 0.0002 WETH
  const swap = (over: Partial<Extract<Intent, { kind: 'swap' }>> = {}) =>
    ({ kind: 'swap', tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '0.5', slippageBps: 50, ...over }) as Extract<
      Intent,
      { kind: 'swap' }
    >;

  it('T1 auto: bounded swap to the allowlisted router within auto limits', () => {
    const d = evaluate(swap(), policy, fresh(), CHAIN, quote);
    expect(d.tier).toBe('T1_AUTO');
    expect(d.amountBase).toBe(parseUnits('0.5', 6));
    expect(d.minAmountOut).toBe((quote.amountOut * 9950n) / 10_000n);
  });

  it('T2 confirm: slippage above the auto slippage limit but within the cap', () => {
    const d = evaluate(swap({ slippageBps: 80 }), policy, fresh(), CHAIN, quote);
    expect(d.tier).toBe('T2_CONFIRM');
    expect(d.reasons.join()).toMatch(/slippage cap/i);
  });

  it('T2 confirm: amount above the auto limit', () => {
    const d = evaluate(swap({ amountIn: '2' }), policy, fresh(), CHAIN, quote);
    expect(d.tier).toBe('T2_CONFIRM');
  });

  it('T3 deny: unknown router (malicious venue)', () => {
    const d = evaluate(swap({ router: STRANGER }), policy, fresh(), CHAIN, quote);
    expect(d.tier).toBe('T3_DENY');
    expect(d.reasons.join()).toMatch(/venue/i);
  });

  it('T3 deny: huge slippage cap (malicious variant)', () => {
    const d = evaluate(swap({ slippageBps: 150 }), policy, fresh(), CHAIN, quote);
    expect(d.tier).toBe('T3_DENY');
    expect(d.reasons.join()).toMatch(/exceeds the maximum/i);
  });

  it('T3 deny: zero slippage cap (no cap provided)', () => {
    expect(evaluate(swap({ slippageBps: 0 }), policy, fresh(), CHAIN, quote).tier).toBe('T3_DENY');
  });

  it('T3 deny: no market quote', () => {
    const d = evaluate(swap(), policy, fresh(), CHAIN, undefined);
    expect(d.tier).toBe('T3_DENY');
    expect(d.reasons.join()).toMatch(/quote/i);
  });

  it('T3 deny: over the hard cap or the daily budget', () => {
    expect(evaluate(swap({ amountIn: '50' }), policy, fresh(), CHAIN, quote).tier).toBe('T3_DENY');
    const spent = { ...fresh(), spentToday: { USDC: parseUnits('24.8', 6) } };
    expect(evaluate(swap(), policy, spent, CHAIN, quote).tier).toBe('T3_DENY');
  });

  it('T3 deny: unknown or identical tokens', () => {
    expect(evaluate(swap({ tokenOut: 'SCAM' }), policy, fresh(), CHAIN, quote).tier).toBe('T3_DENY');
    expect(evaluate(swap({ tokenOut: 'USDC' }), policy, fresh(), CHAIN, quote).tier).toBe('T3_DENY');
  });

  it('T3 deny: swaps are refused when the policy has no swap config', () => {
    const noSwap = PolicySchema.parse({ ...policy, swap: undefined });
    expect(evaluate(swap(), noSwap, fresh(), CHAIN, quote).tier).toBe('T3_DENY');
  });
});
