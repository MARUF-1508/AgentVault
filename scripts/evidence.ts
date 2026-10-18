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
const vaultTxs: { label: string; hash: string; result: 'confirmed' | 'reverted' }[] = [];
if (env.VAULT_SET_RECIPIENT_TX)
  vaultTxs.push({ label: 'Owner allowlist (alice)', hash: env.VAULT_SET_RECIPIENT_TX, result: 'confirmed' });
if (env.VAULT_SEND_TX)
  vaultTxs.push({ label: 'Within-limit agent send (0.0002 ETH to alice)', hash: env.VAULT_SEND_TX, result: 'confirmed' });
if (env.VAULT_REVERT_TX)
  vaultTxs.push({ label: 'Over-cap agent call (0.001 ETH)', hash: env.VAULT_REVERT_TX, result: 'reverted' });
if (env.VAULT_DENY_TX)
  vaultTxs.push({ label: 'Non-allowlisted agent call', hash: env.VAULT_DENY_TX, result: 'reverted' });

// Optional v2 vault (session keys + ERC-20), shown as its own section so the v1
// hashes above keep their original addresses and stay verifiable.
const vaultV2Txs: { label: string; hash: string; result: 'confirmed' | 'reverted' }[] = [];
if (env.VAULT2_GRANT_SESSION_TX)
  vaultV2Txs.push({ label: 'Owner grants a session key (caps ≤ vault, 1-day expiry)', hash: env.VAULT2_GRANT_SESSION_TX, result: 'confirmed' });
if (env.VAULT2_SEND_TX)
  vaultV2Txs.push({ label: 'Session-key send within its own cap', hash: env.VAULT2_SEND_TX, result: 'confirmed' });
if (env.VAULT2_REVERT_TX)
  vaultV2Txs.push({ label: 'Session-key call over its cap', hash: env.VAULT2_REVERT_TX, result: 'reverted' });

const md = renderEvidence(entries, {
  auditLogPath: env.AUDIT_LOG,
  chainIntegrity: audit.verify(),
  vault: env.VAULT_ADDRESS
    ? { address: env.VAULT_ADDRESS, deployTx: env.VAULT_DEPLOY_TX, txs: vaultTxs, explorerBase }
    : undefined,
  vaults: env.VAULT2_ADDRESS
    ? [
        {
          title: 'AgentVault v2 (session keys + ERC-20)',
          address: env.VAULT2_ADDRESS,
          deployTx: env.VAULT2_DEPLOY_TX,
          txs: vaultV2Txs,
          explorerBase,
        },
      ]
    : undefined,
});
mkdirSync('docs', { recursive: true });
writeFileSync('docs/EXECUTION_EVIDENCE.md', md);

const sent = entries.filter((e) => e.type === 'tx_sent').length;
const denied = entries.filter((e) => e.type === 'decision' && e.data.tier === 'T3_DENY').length;
console.log(`Wrote docs/EXECUTION_EVIDENCE.md (${sent} transactions, ${denied} denials).`);
