import { describe, expect, it } from 'vitest';
import { buildComplianceReport } from '../src/report/compliance.js';
import { harness } from './helpers.js';

describe('compliance export (S7)', () => {
  it('summarises decisions, approvals, transactions, access events and integrity', () => {
    const { audit } = harness();
    audit.append('intent', { intent: { kind: 'native_transfer' } });
    audit.append('decision', { tier: 'T2_CONFIRM', reasons: ['new recipient'] });
    audit.append('approval', { approved: true, by: 'human' });
    audit.append('access', { event: 'decide', user: 'olivia', approved: true });
    audit.append('tx_sent', { hash: '0xaa', tier: 'T2_CONFIRM', asset: 'ETH', amountBase: '1', countsToBudget: true });
    audit.append('tx_confirmed', { hash: '0xaa', blockNumber: 1 });
    audit.append('decision', { tier: 'T3_DENY', reasons: ['over the hard cap'] });
    audit.append('tx_sent', { hash: '0xbb', tier: 'T1_AUTO', asset: 'ETH', amountBase: '1', countsToBudget: true });
    audit.append('anchor', { seq: 7, headHash: 'x', txHash: '0xcc' });
    audit.append('kill_switch', { paused: true, by: 'web', user: 'olivia' });

    const r = buildComplianceReport(audit.read(), {
      chain: { name: 'Base Sepolia', id: 84532 },
      wallet: '0x1111111111111111111111111111111111111111',
      policySha256: 'abc',
      integrity: audit.verify(),
      now: new Date('2026-10-19T00:00:00Z'),
    });
    expect(r.integrity).toMatchObject({ ok: true, entries: 10 });
    expect(r.totals.decisions).toEqual({ T1_AUTO: 0, T2_CONFIRM: 1, T3_DENY: 1 });
    expect(r.totals.approvals).toEqual({ approved: 1, rejected: 0 });
    expect(r.totals.transactions).toEqual({ sent: 2, confirmed: 1, reverted: 0, pending: 1 });
    expect(r.approvals).toEqual([expect.objectContaining({ by: 'olivia', approved: true, channel: 'web' })]);
    expect(r.denials[0]!.reasons).toEqual(['over the hard cap']);
    expect(r.anchors).toEqual([expect.objectContaining({ seq: 7, txHash: '0xcc' })]);
    expect(r.accessEvents.map((e) => e.event)).toEqual(['decide', 'pause']);
    expect(r.policy.tiers.T3_DENY).toMatch(/cannot be approved/);
  });

  it('filters by period and reports a broken chain', () => {
    const { audit } = harness();
    audit.append('decision', { tier: 'T1_AUTO' });
    const r = buildComplianceReport(audit.read(), {
      chain: { name: 'x', id: 1 },
      wallet: null,
      policySha256: null,
      integrity: { ok: false, brokenAt: 0, reason: 'content hash mismatch' },
      from: '2999-01-01T00:00:00Z',
    });
    expect(r.totals.decisions.T1_AUTO).toBe(0);
    expect(r.integrity).toMatchObject({ ok: false, brokenAt: 0 });
  });
});
