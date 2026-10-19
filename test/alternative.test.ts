import { describe, expect, it } from 'vitest';
import { compliantAlternative, explainTier } from '../src/policy/alternative.js';
import { evaluate } from '../src/policy/engine.js';
import type { SpendState } from '../src/policy/types.js';
import { ALICE, BOB, basePolicy, CHAIN_ID, harness } from './helpers.js';

const policy = basePolicy({ recipients: { allowlist: { alice: ALICE }, denylist: ['0x000000000000000000000000000000000000dEaD'] } });
const fresh: SpendState = { spentToday: {}, txLastHour: 0, paused: false };
const send = (to: string, amount: string) => ({ kind: 'native_transfer' as const, to: to as `0x${string}`, amount });

describe('compliant alternative (T1)', () => {
  it('over the hard cap: offers the hard cap itself, proven by the engine', () => {
    const alt = compliantAlternative(send(ALICE, '1'), policy, fresh, CHAIN_ID);
    expect(alt?.kind).toBe('amount');
    if (alt?.kind !== 'amount') return;
    expect(alt.intent).toMatchObject({ amount: '0.005', to: ALICE });
    expect(alt.decision.tier).toBe('T2_CONFIRM');
    // The proof: the engine itself accepts the suggestion.
    expect(evaluate(alt.intent, policy, fresh, CHAIN_ID).tier).toBe('T2_CONFIRM');
  });

  it('over the remaining budget: offers what is left of today', () => {
    const spent: SpendState = { ...fresh, spentToday: { ETH: 8_000_000_000_000_000n } }; // 0.008 of 0.01
    const alt = compliantAlternative(send(ALICE, '0.004'), policy, spent, CHAIN_ID);
    expect(alt).toMatchObject({ kind: 'amount', intent: { amount: '0.002' } });
  });

  it('budget used up: no amount, but says when it resets', () => {
    const spent: SpendState = { ...fresh, spentToday: { ETH: 10_000_000_000_000_000n } };
    const alt = compliantAlternative(send(ALICE, '0.001'), policy, spent, CHAIN_ID);
    expect(alt).toEqual({ kind: 'none', note: expect.stringMatching(/resets at 00:00 UTC/) });
  });

  it('a known recipient above the auto limit: offers the auto limit as a T1 alternative', () => {
    const alt = compliantAlternative(send(ALICE, '0.003'), policy, fresh, CHAIN_ID);
    expect(alt).toMatchObject({ kind: 'amount', intent: { amount: '0.001' }, decision: { tier: 'T1_AUTO' } });
  });

  it('a new recipient within limits: no alternative (it needs one approval whatever the amount)', () => {
    expect(compliantAlternative(send(BOB, '0.0001'), policy, fresh, CHAIN_ID)).toBeUndefined();
  });

  it('a denylisted recipient: refuses to suggest a smaller amount', () => {
    const alt = compliantAlternative(send('0x000000000000000000000000000000000000dEaD', '0.0001'), policy, fresh, CHAIN_ID);
    expect(alt).toEqual({ kind: 'none', note: expect.stringMatching(/not about the amount/) });
  });

  it('respects the anomaly guard by scaling the USD value with the amount', () => {
    const guarded = basePolicy({ risk: { maxActionPctOfPortfolio: 50 } });
    // Portfolio $100; 0.004 ETH is worth $80 -> refused; the alternative must be <= $50.
    const s: SpendState = { ...fresh, risk: { portfolioUsd: 100n * 10n ** 8n, amountUsd: 80n * 10n ** 8n } };
    expect(evaluate(send(ALICE, '0.004'), guarded, s, CHAIN_ID).tier).toBe('T3_DENY');
    const alt = compliantAlternative(send(ALICE, '0.004'), guarded, s, CHAIN_ID);
    expect(alt).toMatchObject({ kind: 'amount', intent: { amount: '0.0025' } });
  });

  it('explains every tier in one plain sentence', () => {
    expect(explainTier('T1_AUTO')).toMatch(/automatic/);
    expect(explainTier('T2_CONFIRM')).toMatch(/owner must approve/);
    expect(explainTier('T3_DENY')).toMatch(/Nobody can approve/);
  });

  it('the executor attaches the alternative to a refused preview', async () => {
    const { executor } = harness({ policy });
    const r = await executor.previewWithAlternative(send(ALICE, '1'));
    expect(r.decision.tier).toBe('T3_DENY');
    expect(r.alternative).toMatchObject({ kind: 'amount', intent: { amount: '0.005' } });
    expect((await executor.previewWithAlternative(send(ALICE, '0.0001'))).alternative).toBeUndefined();
  });
});
