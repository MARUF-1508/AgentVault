import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../src/audit/log.js';
import { dailyStats } from '../src/report/stats.js';

let seq = 0;
const entry = (ts: string, type: AuditEntry['type'], data: Record<string, unknown> = {}): AuditEntry =>
  ({ seq: seq++, ts, type, data, prevHash: '', hash: '' });

const now = new Date('2026-10-17T12:00:00Z');

describe('dailyStats', () => {
  it('returns the requested number of days ending today, in order', () => {
    const stats = dailyStats([], 3, now);
    expect(stats.map((s) => s.date)).toEqual(['2026-10-15', '2026-10-16', '2026-10-17']);
  });

  it('counts broadcast txs and sums budget-counting spend per asset', () => {
    const stats = dailyStats(
      [
        entry('2026-10-16T08:00:00Z', 'tx_sent', { asset: 'ETH', amountBase: '100000000000000', countsToBudget: true }),
        entry('2026-10-16T09:00:00Z', 'tx_sent', { asset: 'ETH', amountBase: '500000000000000', countsToBudget: true }),
        entry('2026-10-16T09:30:00Z', 'tx_sent', { asset: 'USDC', amountBase: '2000000', countsToBudget: true }),
      ],
      2,
      now,
    );
    const day = stats[0]!;
    expect(day.txCount).toBe(3);
    expect(day.spentBase).toEqual({ ETH: '600000000000000', USDC: '2000000' });
  });

  it('does not count approvals toward spend or tx count', () => {
    const stats = dailyStats([entry('2026-10-17T01:00:00Z', 'tx_sent', { asset: 'USDC', amountBase: '5', countsToBudget: false })], 1, now);
    expect(stats[0]!.txCount).toBe(1);
    expect(stats[0]!.spentBase).toEqual({});
  });

  it('counts T3 denials but ignores other decisions and out-of-range days', () => {
    const stats = dailyStats(
      [
        entry('2026-10-17T02:00:00Z', 'decision', { tier: 'T3_DENY' }),
        entry('2026-10-17T02:01:00Z', 'decision', { tier: 'T2_CONFIRM' }),
        entry('2026-10-01T00:00:00Z', 'tx_sent', { countsToBudget: true, asset: 'ETH', amountBase: '1' }),
      ],
      1,
      now,
    );
    expect(stats[0]!.deniedCount).toBe(1);
    expect(stats[0]!.txCount).toBe(0);
  });
});
