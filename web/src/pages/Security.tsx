import { motion } from 'framer-motion';
import { Ban, CheckCircle2, Eye, Fingerprint, Hand, Landmark } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '../auth';
import AuditAnchor from '../components/AuditAnchor';
import PolicySimulator from '../components/PolicySimulator';
import { useWallet } from '../data';
import { CopyButton, shortAddr, usePageTitle } from '../format';

const TIERS: { tier: string; cls: string; icon: ReactNode; title: string; who: string; examples: string }[] = [
  { tier: 'T0', cls: 'tier-t0', icon: <Eye size={18} />, title: 'Read-only', who: 'Agent, freely', examples: 'Balances, policy, quotes, history' },
  { tier: 'T1', cls: 'tier-t1', icon: <CheckCircle2 size={18} />, title: 'Automatic', who: 'Agent, no human', examples: 'Small sends to allowlisted recipients inside the daily budget' },
  { tier: 'T2', cls: 'tier-t2', icon: <Hand size={18} />, title: 'Needs approval', who: 'An owner must click Approve', examples: 'New recipients, amounts above the auto limit, contract recipients' },
  { tier: 'T3', cls: 'tier-t3', icon: <Ban size={18} />, title: 'Refused', who: 'Nobody', examples: 'Over the hard cap or budget, denylisted, unlimited approvals, paused' },
];

const ROLE_ROWS: [string, boolean, boolean, boolean][] = [
  ['Read balances, policy and audit trail', true, true, true],
  ['Preview tiers and send transfers', false, true, true],
  ['Chat with the agent (text or voice)', false, true, true],
  ['Approve or reject T2 transactions', false, false, true],
  ['Pause the wallet (kill switch)', false, false, true],
  ['Resume signing (password again)', false, false, true],
  ['Rotate the signing key or add users', false, false, true],
  ['Change limits in the policy file', false, false, false],
];

export default function Security() {
  usePageTitle('Security');
  const { policy, status } = useWallet();
  const { me } = useAuth();
  const allow = Object.entries(policy?.recipients.allowlist ?? {});
  const limits = policy ? [{ asset: policy.native.symbol, ...policy.native }, ...Object.entries(policy.tokens).map(([asset, t]) => ({ asset, ...t }))] : [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Security</h1>
          <p className="muted">The LLM plans, a deterministic policy engine decides, and the chain enforces. These rules are read-only here.</p>
        </div>
      </div>

      <div className="tier-grid">
        {TIERS.map((t, i) => (
          <motion.div key={t.tier} className={`card tier-card ${t.cls}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <div className="row">
              {t.icon}
              <strong>
                {t.tier} · {t.title}
              </strong>
            </div>
            <p className="small">{t.examples}</p>
            <p className="muted small">Decided by: {t.who}</p>
          </motion.div>
        ))}
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Limits per asset</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Auto up to</th>
                  <th>Hard cap</th>
                  <th>Per day</th>
                </tr>
              </thead>
              <tbody>
                {limits.map((l) => (
                  <tr key={l.asset}>
                    <td>{l.asset}</td>
                    <td className="mono">{l.autoMaxPerTx}</td>
                    <td className="mono">{l.hardMaxPerTx}</td>
                    <td className="mono">{l.dailyBudget}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">Rate limit: {policy?.rateLimit.maxTxPerHour ?? '…'} transactions per hour. Limits live in <code>config/policy.json</code>.</p>
        </section>

        <section className="card">
          <h2>Recipients</h2>
          <h3>Allowlisted</h3>
          <ul className="addr-list">
            {allow.map(([label, addr]) => (
              <li key={addr}>
                <span>{label}</span>
                <span className="mono" title={addr}>
                  {shortAddr(addr)}
                </span>
                <CopyButton value={addr} />
              </li>
            ))}
          </ul>
          <h3>Denylisted</h3>
          <ul className="addr-list">
            {(policy?.recipients.denylist ?? []).map((addr) => (
              <li key={addr}>
                <span className="mono" title={addr}>
                  {shortAddr(addr)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Roles</h2>
          <div className="table-wrap">
            <table className="roles">
              <thead>
                <tr>
                  <th>Can…</th>
                  <th className={me?.role === 'viewer' ? 'mine' : ''}>Viewer</th>
                  <th className={me?.role === 'operator' ? 'mine' : ''}>Operator</th>
                  <th className={me?.role === 'owner' ? 'mine' : ''}>Owner</th>
                </tr>
              </thead>
              <tbody>
                {ROLE_ROWS.map(([label, ...cells]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    {cells.map((ok, i) => (
                      <td key={i} aria-label={ok ? 'yes' : 'no'}>
                        {ok ? <CheckCircle2 size={16} className="ok-icon" /> : <span className="muted">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">The server checks the role on every request; hiding buttons is only a convenience. Limits and the policy file are never editable from the app or the model.</p>
        </section>

        <section className="card">
          <h2 className="row">
            <Fingerprint size={18} aria-hidden /> Policy fingerprint
          </h2>
          {status?.policyHash ? (
            <p>
              <span className="mono">{status.policyHash}</span>
              <br />
              <span className="muted small">
                sha256 of <code>config/policy.json</code> as loaded by the server. If this hash changes, the limits changed — compare it against the audit trail.
              </span>
              {status.policyIntegrity && (
                <span className="row integrity-row">
                  <span className={`badge ${status.policyIntegrity.drift ? 'bad' : 'ok'}`}>
                    {status.policyIntegrity.drift ? 'File changed outside the app' : 'Matches what the server loaded'}
                  </span>
                  <span className={`badge ${status.policyIntegrity.pinned ? (status.policyIntegrity.matchesPin ? 'ok' : 'bad') : ''}`}>
                    {status.policyIntegrity.pinned ? (status.policyIntegrity.matchesPin ? 'Pinned hash matches' : 'Pinned hash MISMATCH') : 'Not pinned (set POLICY_SHA256)'}
                  </span>
                </span>
              )}
            </p>
          ) : (
            <p className="muted">Policy file hash unavailable.</p>
          )}
        </section>

        <section className="card">
          <h2 className="row">
            <Landmark size={18} aria-hidden /> On-chain guard
          </h2>
          {status?.vault ? (
            <>
              <p>
                Vault mode is on. Native transfers are paid out by <span className="mono">{shortAddr(status.vault)}</span>, which re-checks per-transaction and daily caps
                and the allowlist on-chain. Even a stolen agent key cannot move more than one day's limit.
              </p>
              {status.explorer && (
                <a href={`${status.explorer}/address/${status.vault}`} target="_blank" rel="noreferrer">
                  View the vault on the explorer
                </a>
              )}
            </>
          ) : (
            <p>
              Direct mode: the agent key signs transfers itself and the off-chain policy is the guard. Set <code>VAULT=true</code> and <code>VAULT_ADDRESS</code> to route
              ETH through the AgentVault contract.
            </p>
          )}
        </section>
      </div>

      <div className="grid-2">
        <PolicySimulator />
        <AuditAnchor />
      </div>
    </>
  );
}
