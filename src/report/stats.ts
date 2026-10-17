import type { AuditEntry } from '../audit/log.js';

export interface DailyStat {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  /** Transactions broadcast that day. */
  txCount: number;
  /** Requests refused by policy (T3) that day. */
  deniedCount: number;
  /** Budget-counting spend per asset symbol, in base units (string, as stored). */
  spentBase: Record<string, string>;
}

const dayKey = (iso: string): string => iso.slice(0, 10);

/**
 * Rebuilds a per-day activity series from the audit log. Pure: the caller
 * passes the entries and "today", so tests never depend on the wall clock.
 */
export function dailyStats(entries: AuditEntry[], days = 14, now: Date = new Date()): DailyStat[] {
  const buckets = new Map<string, DailyStat>();
  const out: DailyStat[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const stat: DailyStat = { date: d.toISOString().slice(0, 10), txCount: 0, deniedCount: 0, spentBase: {} };
    buckets.set(stat.date, stat);
    out.push(stat);
  }

  for (const e of entries) {
    const stat = buckets.get(dayKey(e.ts));
    if (!stat) continue;
    if (e.type === 'tx_sent') {
      stat.txCount++;
      if (e.data.countsToBudget && typeof e.data.asset === 'string' && typeof e.data.amountBase === 'string') {
        const asset = e.data.asset;
        stat.spentBase[asset] = (BigInt(stat.spentBase[asset] ?? '0') + BigInt(e.data.amountBase)).toString();
      }
    } else if (e.type === 'decision' && e.data.tier === 'T3_DENY') {
      stat.deniedCount++;
    }
  }
  return out;
}
