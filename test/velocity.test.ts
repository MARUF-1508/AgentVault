import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../src/audit/log.js';
import { evaluate } from '../src/policy/engine.js';
import { spendStateFrom } from '../src/policy/state.js';
import type { SpendState } from '../src/policy/types.js';
import { ALICE, basePolicy, CHAIN_ID, harness } from './helpers.js';

const policy = basePolicy({ rateLimit: { maxTxPerHour: 20, velocity: { windowMinutes: 10, maxTx: 3, maxSpendPct: 50 } } });
const send = (amount: string) => ({ kind: 'native_transfer' as const, to: ALICE, amount });
const state = (txInWindow: number, spentWei: bigint): SpendState => ({
  spentToday: { ETH: spentWei },
  txLastHour: txInWindow,
  paused: false,
  velocity: { txInWindow, spentInWindow: { ETH: spentWei } },
});

describe('velocity guard (S5)', () => {
  it('refuses once the window already holds maxTx transactions', () => {
    const d = evaluate(send('0.0001'), policy, state(3, 0n), CHAIN_ID);
    expect(d.tier).toBe('T3_DENY');
    expect(d.reasons[0]).toMatch(/Velocity guard: 3 transactions in the last 10 minutes/);
  });

  it('refuses a burst that would move more than maxSpendPct of the daily budget inside the window', () => {
    // Budget 0.01, 50% => at most 0.005 per 10 minutes. 0.0041 already moved.
    const d = evaluate(send('0.001'), policy, state(1, 4_100_000_000_000_000n), CHAIN_ID);
    expect(d.tier).toBe('T3_DENY');
    expect(d.reasons[0]).toMatch(/Velocity guard: .* at most 0.005 ETH \(50% of the daily budget\)/);
    // Landing exactly on the cap is fine.
    expect(evaluate(send('0.001'), policy, state(1, 4_000_000_000_000_000n), CHAIN_ID).tier).not.toBe('T3_DENY');
  });

  it('stays off when the policy has no velocity block, or the state carries no window', () => {
    expect(evaluate(send('0.0001'), basePolicy(), { ...state(99, 0n), txLastHour: 0 }, CHAIN_ID).tier).toBe('T1_AUTO');
    expect(evaluate(send('0.0001'), policy, { spentToday: {}, txLastHour: 0, paused: false }, CHAIN_ID).tier).toBe('T1_AUTO');
  });

  it('spendStateFrom counts only transactions inside the rolling window', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const tx = (minutesAgo: number, amountBase: string): AuditEntry => ({
      seq: 0,
      ts: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
      type: 'tx_sent',
      data: { asset: 'ETH', amountBase, countsToBudget: true },
      prevHash: '',
      hash: '',
    });
    const s = spendStateFrom([tx(30, '5'), tx(9, '7'), tx(1, '11')], '/nonexistent/PAUSED', now, 10);
    expect(s.velocity).toEqual({ txInWindow: 2, spentInWindow: { ETH: 18n } });
    expect(s.spentToday.ETH).toBe(23n);
  });

  it('the executor feeds the window from the audit log, so the 4th quick send is refused', async () => {
    const { executor, sent } = harness({ policy });
    for (let i = 0; i < 3; i++) expect((await executor.execute(send('0.0001'))).status).toBe('executed');
    const fourth = await executor.execute(send('0.0001'));
    expect(fourth.status).toBe('denied');
    expect(fourth.decision.reasons.join(' ')).toMatch(/Velocity guard/);
    expect(sent).toHaveLength(3);
  });
});
