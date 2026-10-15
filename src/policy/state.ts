import { existsSync } from 'node:fs';
import type { AuditEntry } from '../audit/log.js';
import type { SpendState } from './types.js';

/**
 * Rebuild spend state from the audit log. Anything broadcast counts toward the
 * budget even if it later fails, so a failing transaction can't be retried to
 * drain more than the budget.
 */
export function spendStateFrom(entries: AuditEntry[], pauseFile: string, now: Date = new Date()): SpendState {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const hourAgo = now.getTime() - 60 * 60 * 1000;
  const spentToday: Record<string, bigint> = {};
  let txLastHour = 0;

  for (const e of entries) {
    if (e.type !== 'tx_sent') continue;
    const t = Date.parse(e.ts);
    if (t >= hourAgo) txLastHour++;
    if (t >= dayStart && e.data.countsToBudget) {
      const asset = String(e.data.asset);
      spentToday[asset] = (spentToday[asset] ?? 0n) + BigInt(String(e.data.amountBase));
    }
  }
  return { spentToday, txLastHour, paused: existsSync(pauseFile) };
}
