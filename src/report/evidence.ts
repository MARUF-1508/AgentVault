import type { AuditEntry } from '../audit/log.js';

export type ChainIntegrity = { ok: true } | { ok: false; brokenAt: number; reason: string };

export interface VaultEvidence {
  /** Optional heading, e.g. "AgentVault v2 (session keys + ERC-20)". */
  title?: string;
  address: string;
  deployTx?: string;
  txs?: { label: string; hash: string; result: 'confirmed' | 'reverted' }[];
  explorerBase?: string;
}

export interface EvidenceOptions {
  /** Where the entries were read from (shown in the generated document). */
  auditLogPath: string;
  /** Result of AuditLog.verify() over the same entries. */
  chainIntegrity: ChainIntegrity;
  /** Injectable clock for deterministic output. */
  now?: Date;
  /** Deployed vault and its externally-observed transactions (deploy + demos). */
  vault?: VaultEvidence;
  /** Extra vaults rendered after `vault` (e.g. the v2 contract, at its own address). */
  vaults?: VaultEvidence[];
}

/**
 * Renders `docs/EXECUTION_EVIDENCE.md` from audit entries: every on-chain tx hash
 * with its tier, outcome and explorer link. Pure, so it is unit-testable without a
 * filesystem; the caller reads the log and verifies the chain.
 */
export function renderEvidence(entries: AuditEntry[], opts: EvidenceOptions): string {
  const outcome = new Map<string, string>();
  for (const e of entries) {
    if (e.type === 'tx_confirmed') outcome.set(String(e.data.hash), `✅ block ${e.data.blockNumber}`);
    if (e.type === 'tx_failed' && e.data.hash) outcome.set(String(e.data.hash), '❌ reverted');
  }
  const sent = entries.filter((e) => e.type === 'tx_sent');
  const denied = entries.filter((e) => e.type === 'decision' && e.data.tier === 'T3_DENY');

  const rows = sent.map((e) => {
    const i = (e.data.intent ?? {}) as Record<string, unknown>;
    const kind = String(i.kind ?? '?');
    // The amount lives under a different key per intent: swaps carry amountIn;
    // an audit anchor moves nothing and names the entry it commits to.
    const amount = kind === 'audit_anchor' ? `0 (audit entry #${String(i.seq)})` : String(i.amount ?? i.amountIn ?? '?');
    const h = String(e.data.hash);
    return `| ${e.ts} | ${kind} | ${amount} ${e.data.asset} | ${e.data.tier} | ${outcome.get(h) ?? 'pending'} | [${h.slice(0, 10)}…](${e.data.explorerUrl}) |`;
  });

  const now = opts.now ?? new Date();
  const integrity = opts.chainIntegrity.ok ? '✅ intact' : `❌ broken at entry ${opts.chainIntegrity.brokenAt}`;
  const vaults = [opts.vault, ...(opts.vaults ?? [])].filter((v): v is VaultEvidence => Boolean(v));
  return `# Execution Evidence

Generated ${now.toISOString()} from \`${opts.auditLogPath}\`.
Audit chain integrity: ${integrity}
${vaults.map(renderVault).join('')}
## On-chain transactions (${sent.length})

| Time (UTC) | Action | Amount | Tier | Result | Tx hash |
|---|---|---|---|---|---|
${rows.join('\n') || '| | | | | | |'}

## Blocked by policy (${denied.length})

${denied.map((e) => `- ${e.ts}: ${(e.data.reasons as string[]).join(' ')}`).join('\n') || '_none yet_'}
`;
}

/** Vault deployment and revert-demo hashes. Observed externally (explorer/RPC), not from the audit log. */
function renderVault(vault: VaultEvidence): string {
  const base = (vault.explorerBase ?? '').replace(/\/$/, '');
  const link = (kind: 'address' | 'tx', hash: string) => (base ? `[${hash.slice(0, 10)}…](${base}/${kind}/${hash})` : hash);
  const lines = [`## ${vault.title ?? 'AgentVault'} (on-chain enforcement)`, '', `Vault: ${link('address', vault.address)}`];
  if (vault.deployTx) lines.push(`Deploy tx: ${link('tx', vault.deployTx)} ✅ deployed`);
  for (const t of vault.txs ?? []) {
    const mark = t.result === 'reverted' ? '❌ reverted on-chain' : '✅ confirmed';
    lines.push(`${t.label}: ${link('tx', t.hash)} ${mark}`);
  }
  return lines.join('\n') + '\n\n';
}
