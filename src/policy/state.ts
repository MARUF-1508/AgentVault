import { existsSync } from 'node:fs';
import type { AuditEntry } from '../audit/log.js';
import type { SpendState } from './types.js';

/**
 * Rebuild spend state from the audit log. Anything broadcast counts toward the
 * budget even if it later fails, so a failing transaction can't be retried to
 * drain more than the budget.
 */
export function spendStateFrom(
  entries: AuditEntry[],
  pauseFile: string,
  now: Date = new Date(),
  /** Rolling velocity window in minutes (policy.rateLimit.velocity); omit to skip. */
  velocityWindowMinutes?: number,
): SpendState {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const hourAgo = now.getTime() - 60 * 60 * 1000;
  const windowStart = velocityWindowMinutes ? now.getTime() - velocityWindowMinutes * 60 * 1000 : undefined;
  const spentToday: Record<string, bigint> = {};
  const spentInWindow: Record<string, bigint> = {};
  let txLastHour = 0;
  let txInWindow = 0;

  for (const e of entries) {
    if (e.type !== 'tx_sent') continue;
    const t = Date.parse(e.ts);
    if (t >= hourAgo) txLastHour++;
    const inWindow = windowStart !== undefined && t >= windowStart;
    if (inWindow) txInWindow++;
    if (!e.data.countsToBudget) continue;
    const asset = String(e.data.asset);
    const amount = BigInt(String(e.data.amountBase));
    if (t >= dayStart) spentToday[asset] = (spentToday[asset] ?? 0n) + amount;
    if (inWindow) spentInWindow[asset] = (spentInWindow[asset] ?? 0n) + amount;
  }
  const state: SpendState = { spentToday, txLastHour, paused: existsSync(pauseFile) };
  if (windowStart !== undefined) state.velocity = { txInWindow, spentInWindow };
  return state;
}
