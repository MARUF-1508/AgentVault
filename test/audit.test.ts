import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit/log.js';
import { spendStateFrom } from '../src/policy/state.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.jsonl');

describe('audit log', () => {
  it('chains entries and verifies', () => {
    const log = new AuditLog(tmp());
    log.append('intent', { a: 1 });
    log.append('decision', { tier: 'T1_AUTO', big: 10n ** 30n });
    expect(log.read()).toHaveLength(2);
    expect(log.verify()).toEqual({ ok: true });
  });

  it('detects an edited entry', () => {
    const path = tmp();
    const log = new AuditLog(path);
    log.append('tx_sent', { asset: 'ETH', amountBase: '100', countsToBudget: true });
    log.append('tx_confirmed', { hash: '0xabc' });
    writeFileSync(path, readFileSync(path, 'utf8').replace('"100"', '"1"'));
    expect(log.verify()).toMatchObject({ ok: false, brokenAt: 0 });
  });

  it('detects a deleted entry', () => {
    const path = tmp();
    const log = new AuditLog(path);
    log.append('intent', { n: 1 });
    log.append('intent', { n: 2 });
    log.append('intent', { n: 3 });
    const lines = readFileSync(path, 'utf8').split('\n');
    writeFileSync(path, [lines[0], lines[2]].join('\n') + '\n');
    expect(log.verify().ok).toBe(false);
  });
});

describe('spend state from audit log', () => {
  it('sums today, ignores yesterday and approvals, counts the last hour', () => {
    const now = new Date('2026-10-15T12:00:00Z');
    let clock = new Date('2026-10-14T23:00:00Z');
    const log = new AuditLog(tmp(), () => clock);
    log.append('tx_sent', { asset: 'ETH', amountBase: '500', countsToBudget: true });
    clock = new Date('2026-10-15T11:30:00Z');
    log.append('tx_sent', { asset: 'ETH', amountBase: '200', countsToBudget: true });
    log.append('tx_sent', { asset: 'USDC', amountBase: '7', countsToBudget: false });
    clock = new Date('2026-10-15T08:00:00Z');
    log.append('tx_sent', { asset: 'ETH', amountBase: '100', countsToBudget: true });

    const s = spendStateFrom(log.read(), '/nonexistent/PAUSED', now);
    expect(s.spentToday).toEqual({ ETH: 300n });
    expect(s.txLastHour).toBe(2);
    expect(s.paused).toBe(false);
  });
});
