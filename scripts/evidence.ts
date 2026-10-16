import { mkdirSync, writeFileSync } from 'node:fs';
import { AuditLog } from '../src/audit/log.js';
import { loadEnv } from '../src/config.js';
import { renderEvidence } from '../src/report/evidence.js';

// Builds docs/EXECUTION_EVIDENCE.md from the audit log: every on-chain tx hash with
// its tier, outcome and explorer link. This is the "real on-chain transaction hashes" deliverable.
const env = loadEnv();
const audit = new AuditLog(env.AUDIT_LOG);
const entries = audit.read();
const explorerBase = env.CHAIN === 'sepolia' ? 'https://sepolia.etherscan.io' : 'https://sepolia.basescan.org';
const md = renderEvidence(entries, {
  auditLogPath: env.AUDIT_LOG,
  chainIntegrity: audit.verify(),
  vault: env.VAULT_ADDRESS
    ? { address: env.VAULT_ADDRESS, deployTx: env.VAULT_DEPLOY_TX, revertTx: env.VAULT_REVERT_TX, explorerBase }
    : undefined,
});
mkdirSync('docs', { recursive: true });
writeFileSync('docs/EXECUTION_EVIDENCE.md', md);

const sent = entries.filter((e) => e.type === 'tx_sent').length;
const denied = entries.filter((e) => e.type === 'decision' && e.data.tier === 'T3_DENY').length;
console.log(`Wrote docs/EXECUTION_EVIDENCE.md (${sent} transactions, ${denied} denials).`);
