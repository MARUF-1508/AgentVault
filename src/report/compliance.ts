import type { AuditEntry } from '../audit/log.js';

/**
 * Compliance export (S7): one self-contained JSON document an auditor can check
 * without running the app. Pure: built from the audit entries plus facts the
 * caller supplies (policy hash, chain-integrity result), so it is easy to test.
 *
 * It answers the questions a reviewer asks: what was attempted, what the policy
 * decided and why, who approved each T2, which transactions went on-chain and
 * how they ended, every access-control event, and whether the log is intact
 * and anchored on-chain.
 */
export interface ComplianceReport {
  generatedAt: string;
  period: { from: string | null; to: string | null };
  chain: { name: string; id: number };
  wallet: string | null;
  policy: { sha256: string | null; tiers: Record<string, string> };
  integrity: { ok: boolean; brokenAt?: number; reason?: string; entries: number; headHash: string | null };
  anchors: { seq: number; txHash: string; ts: string }[];
  totals: {
    intents: number;
    decisions: Record<'T1_AUTO' | 'T2_CONFIRM' | 'T3_DENY', number>;
    approvals: { approved: number; rejected: number };
    transactions: { sent: number; confirmed: number; reverted: number; pending: number };
  };
  transactions: {
    hash: string;
    ts: string;
    tier: unknown;
    asset: unknown;
    amountBase: unknown;
    intent: unknown;
    outcome: 'confirmed' | 'reverted' | 'pending';
    explorerUrl: unknown;
  }[];
  denials: { seq: number; ts: string; reasons: unknown }[];
  approvals: { seq: number; ts: string; approved: unknown; by: unknown; channel: unknown }[];
  accessEvents: { seq: number; ts: string; event: unknown; user: unknown; ok: unknown }[];
}

export function buildComplianceReport(
  allEntries: AuditEntry[],
  facts: {
    chain: { name: string; id: number };
    wallet: string | null;
    policySha256: string | null;
    integrity: { ok: true } | { ok: false; brokenAt: number; reason: string };
    now?: Date;
    from?: string;
    to?: string;
  },
): ComplianceReport {
  const from = facts.from ? Date.parse(facts.from) : undefined;
  const to = facts.to ? Date.parse(facts.to) : undefined;
  const entries = allEntries.filter((e) => {
    const t = Date.parse(e.ts);
    return (from === undefined || t >= from) && (to === undefined || t <= to);
  });

  const outcome = new Map<string, 'confirmed' | 'reverted'>();
  for (const e of entries) {
    if (e.type === 'tx_confirmed') outcome.set(String(e.data.hash), 'confirmed');
    if (e.type === 'tx_failed' && e.data.hash) outcome.set(String(e.data.hash), 'reverted');
  }

  const decisions = { T1_AUTO: 0, T2_CONFIRM: 0, T3_DENY: 0 };
  const approvals: ComplianceReport['approvals'] = [];
  let approved = 0;
  let rejected = 0;
  for (const e of entries) {
    if (e.type === 'decision' && !e.data.recheck) {
      const tier = e.data.tier as keyof typeof decisions;
      if (tier in decisions) decisions[tier]++;
    }
    if (e.type === 'approval') {
      if (e.data.approved) approved++;
      else rejected++;
    }
    if (e.type === 'access' && e.data.event === 'decide') {
      approvals.push({ seq: e.seq, ts: e.ts, approved: e.data.approved, by: e.data.user ?? null, channel: e.data.channel ?? 'web' });
    }
  }

  const transactions = entries
    .filter((e) => e.type === 'tx_sent')
    .map((e) => ({
      hash: String(e.data.hash),
      ts: e.ts,
      tier: e.data.tier,
      asset: e.data.asset,
      amountBase: e.data.amountBase,
      intent: e.data.intent,
      outcome: outcome.get(String(e.data.hash)) ?? ('pending' as const),
      explorerUrl: e.data.explorerUrl,
    }));

  const integrity = facts.integrity.ok
    ? { ok: true, entries: allEntries.length, headHash: allEntries.at(-1)?.hash ?? null }
    : { ok: false, brokenAt: facts.integrity.brokenAt, reason: facts.integrity.reason, entries: allEntries.length, headHash: allEntries.at(-1)?.hash ?? null };

  return {
    generatedAt: (facts.now ?? new Date()).toISOString(),
    period: { from: facts.from ?? null, to: facts.to ?? null },
    chain: facts.chain,
    wallet: facts.wallet,
    policy: {
      sha256: facts.policySha256,
      tiers: {
        T0: 'read-only, never reaches the policy engine',
        T1_AUTO: 'within the auto limit to a known recipient: executes without a human',
        T2_CONFIRM: 'allowed, but a named owner must approve this exact transaction',
        T3_DENY: 'outside the policy: refused, cannot be approved',
      },
    },
    integrity,
    anchors: entries
      .filter((e) => e.type === 'anchor')
      .map((e) => ({ seq: Number(e.data.seq), txHash: String(e.data.txHash), ts: e.ts })),
    totals: {
      intents: entries.filter((e) => e.type === 'intent').length,
      decisions,
      approvals: { approved, rejected },
      transactions: {
        sent: transactions.length,
        confirmed: transactions.filter((t) => t.outcome === 'confirmed').length,
        reverted: transactions.filter((t) => t.outcome === 'reverted').length,
        pending: transactions.filter((t) => t.outcome === 'pending').length,
      },
    },
    transactions,
    denials: entries
      .filter((e) => e.type === 'decision' && e.data.tier === 'T3_DENY')
      .map((e) => ({ seq: e.seq, ts: e.ts, reasons: e.data.reasons })),
    approvals,
    accessEvents: entries
      .filter((e) => e.type === 'access' || e.type === 'kill_switch')
      .map((e) => ({ seq: e.seq, ts: e.ts, event: e.data.event ?? (e.type === 'kill_switch' ? (e.data.paused ? 'pause' : 'resume') : null), user: e.data.user ?? e.data.by ?? null, ok: e.data.ok ?? null })),
  };
}
