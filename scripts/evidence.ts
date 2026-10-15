import { mkdirSync, writeFileSync } from 'node:fs';
import { AuditLog } from '../src/audit/log.js';
import { loadEnv } from '../src/config.js';

// Builds docs/EXECUTION_EVIDENCE.md from the audit log: every on-chain tx hash with
// its tier, outcome and explorer link. This is the "real on-chain transaction hashes" deliverable.
const env = loadEnv();
const audit = new AuditLog(env.AUDIT_LOG);
const entries = audit.read();
const outcome = new Map<string, string>();
for (const e of entries) {
  if (e.type === 'tx_confirmed') outcome.set(String(e.data.hash), `✅ block ${e.data.blockNumber}`);
  if (e.type === 'tx_failed' && e.data.hash) outcome.set(String(e.data.hash), '❌ reverted');
}
const sent = entries.filter((e) => e.type === 'tx_sent');
const denied = entries.filter((e) => e.type === 'decision' && e.data.tier === 'T3_DENY');
const verify = audit.verify();

const rows = sent.map((e) => {
  const i = e.data.intent as Record<string, string>;
  const h = String(e.data.hash);
  return `| ${e.ts} | ${i.kind} | ${i.amount} ${e.data.asset} | ${e.data.tier} | ${outcome.get(h) ?? 'pending'} | [${h.slice(0, 10)}…](${e.data.explorerUrl}) |`;
});

const md = `# Execution Evidence

Generated ${new Date().toISOString()} from \`${env.AUDIT_LOG}\`.
Audit chain integrity: ${verify.ok ? '✅ intact' : `❌ broken at entry ${verify.brokenAt}`}

## On-chain transactions (${sent.length})

| Time (UTC) | Action | Amount | Tier | Result | Tx hash |
|---|---|---|---|---|---|
${rows.join('\n') || '| | | | | | |'}

## Blocked by policy (${denied.length})

${denied.map((e) => `- ${e.ts}: ${(e.data.reasons as string[]).join(' ')}`).join('\n') || '_none yet_'}
`;
mkdirSync('docs', { recursive: true });
writeFileSync('docs/EXECUTION_EVIDENCE.md', md);
console.log(`Wrote docs/EXECUTION_EVIDENCE.md (${sent.length} transactions, ${denied.length} denials).`);
