import { describe, expect, it } from 'vitest';
import { parseEther, parseUnits } from 'viem';
import { whatIf } from '../src/policy/whatif.js';
import { PolicySchema, type Intent, type SpendState } from '../src/policy/types.js';

const FRIEND = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x2222222222222222222222222222222222222222';
const DEX = '0x3333333333333333333333333333333333333333';
const QUOTER = '0x4444444444444444444444444444444444444444';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHAIN = 84532;

const policy = PolicySchema.parse({
  version: 1,
  chainId: CHAIN,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: { USDC: { address: USDC, decimals: 6, autoMaxPerTx: '1', hardMaxPerTx: '10', dailyBudget: '25' } },
  recipients: { allowlist: { friend: FRIEND }, denylist: [] },
  approvals: { allowUnlimited: false, spenderAllowlist: { dex: DEX } },
  swap: { router: DEX, quoter: QUOTER, feeTier: 3000, maxSlippageBps: 100, autoMaxSlippageBps: 50 },
  prices: { ETH: { fallbackUsd: '2000' }, USDC: { fallbackUsd: '1' } },
  rateLimit: { maxTxPerHour: 5 },
});

const fresh = (): SpendState => ({ spentToday: {}, txLastHour: 0, paused: false });
const native = (amount: string, to = FRIEND): Intent => ({ kind: 'native_transfer', to: to as `0x${string}`, amount });

describe('what-if: counterfactual policy checks', () => {
  it('with no hypothesis, the two evaluations agree', () => {
    const r = whatIf(native('0.0005'), policy, fresh(), CHAIN);
    expect(r.hypothetical).toEqual(r.baseline);
    expect(r.morePermissive).toBe(false);
    expect(r.summary).toMatch(/no change/i);
  });

  it('allowlisting a new recipient relaxes T2 to T1', () => {
    const intent = native('0.0005', STRANGER);
    const r = whatIf(intent, policy, fresh(), CHAIN, { allowRecipients: [STRANGER] });
    expect(r.baseline.tier).toBe('T2_CONFIRM');
    expect(r.hypothetical.tier).toBe('T1_AUTO');
    expect(r.morePermissive).toBe(true);
    expect(r.summary).toContain('T2_CONFIRM → T1_AUTO');
  });

  it('raising the auto limit relaxes an over-auto transfer to T1', () => {
    const r = whatIf(native('0.005'), policy, fresh(), CHAIN, { limits: { autoMaxPerTx: '0.01' } });
    expect(r.baseline.tier).toBe('T2_CONFIRM');
    expect(r.hypothetical.tier).toBe('T1_AUTO');
  });

  it('a smaller daily budget denies a transfer that passes today', () => {
    const r = whatIf(native('0.001'), policy, fresh(), CHAIN, { limits: { dailyBudget: '0.0005' } });
    expect(r.baseline.tier).toBe('T1_AUTO');
    expect(r.hypothetical.tier).toBe('T3_DENY');
    expect(r.morePermissive).toBe(false);
    expect(r.summary).toContain('T1_AUTO → T3_DENY');
  });

  it('assuming money already spent today can push a transfer over budget', () => {
    const r = whatIf(native('0.001'), policy, fresh(), CHAIN, { spentToday: { ETH: parseEther('0.02') } });
    expect(r.baseline.tier).toBe('T1_AUTO');
    expect(r.hypothetical.tier).toBe('T3_DENY');
  });

  it('assuming the kill switch is on refuses everything', () => {
    const r = whatIf(native('0.0005'), policy, fresh(), CHAIN, { paused: true });
    expect(r.hypothetical.tier).toBe('T3_DENY');
  });

  it("applies a limit override to the intent's asset (a token here)", () => {
    const usdc: Intent = { kind: 'erc20_transfer', token: 'USDC', to: FRIEND, amount: '5' };
    const r = whatIf(usdc, policy, fresh(), CHAIN, { limits: { autoMaxPerTx: '10' } });
    expect(r.baseline.tier).toBe('T2_CONFIRM'); // 5 > the USDC auto limit of 1
    expect(r.hypothetical.tier).toBe('T1_AUTO'); // raised to 10 for this run
  });

  it('never changes the policy it is given', () => {
    const before = JSON.stringify(policy, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    whatIf(native('0.005', STRANGER), policy, fresh(), CHAIN, {
      allowRecipients: [STRANGER],
      limits: { autoMaxPerTx: '0.01', hardMaxPerTx: '0.02', dailyBudget: '1' },
    });
    expect(JSON.stringify(policy, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(before);
  });

  it('limit overrides do not apply to swaps (their limits come from swap rules)', () => {
    const swap: Intent = { kind: 'swap', tokenIn: 'USDC', tokenOut: 'ETH', amountIn: '0.5', slippageBps: 50 };
    const market = { amountOut: parseUnits('0.0002', 18) };
    const base = whatIf(swap, policy, fresh(), CHAIN, {}, market);
    const hypo = whatIf(swap, policy, fresh(), CHAIN, { limits: { autoMaxPerTx: '999999', hardMaxPerTx: '999999', dailyBudget: '999999' } }, market);
    expect(hypo.hypothetical.tier).toBe(base.baseline.tier);
    expect(hypo.hypothetical.reasons).toEqual(base.baseline.reasons);
  });
});
