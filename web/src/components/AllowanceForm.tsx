import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { preview, transact, type ActionIntent, type TransactResult, type Verdict } from '../api';
import { useAuth } from '../auth';
import { useWallet } from '../data';
import { linkify, TierBadge } from '../format';

const CUSTOM = '__custom__';

/**
 * ERC-20 allowance control (the CLI's `approve` / `revoke`). An approval is a
 * transaction like any other: preview shows the tier, the executor simulates
 * it, and an unlimited allowance is T3 unless the policy allowlists the spender.
 */
export default function AllowanceForm() {
  const { policy, status, refresh } = useWallet();
  const { can } = useAuth();
  const tokens = Object.keys(policy?.tokens ?? {});
  const allow = policy?.recipients.allowlist ?? {};
  const contacts = policy?.recipients.contacts ?? {};
  const spenders = [...Object.entries(allow).map(([label, address]) => ({ label, address })), ...Object.entries(contacts).map(([label, address]) => ({ label: `contact: ${label}`, address }))];

  const [token, setToken] = useState('');
  const [spender, setSpender] = useState('');
  const [custom, setCustom] = useState('');
  const [amount, setAmount] = useState('0.0005');
  const [unlimited, setUnlimited] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [result, setResult] = useState<TransactResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chosenToken = token || tokens[0] || '';
  const chosenSpender = spender || spenders[0]?.label || CUSTOM;
  const spenderAddress = chosenSpender === CUSTOM ? custom.trim() : (spenders.find((s) => s.label === chosenSpender)?.address ?? '');

  if (!tokens.length) {
    return <p className="notice">This policy has no ERC-20 tokens, so there are no allowances to manage.</p>;
  }

  const intent = (): ActionIntent => ({
    kind: 'erc20_approve',
    token: chosenToken,
    spender: spenderAddress,
    amount: unlimited ? 'unlimited' : amount.trim(),
  });

  const check = () => {
    setBusy(true);
    setError('');
    setResult(null);
    preview(intent())
      .then(setVerdict)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const send = () => {
    setBusy(true);
    setError('');
    transact(intent())
      .then((r) => {
        setResult(r);
        if (r.status !== 'denied') refresh();
        if (r.txHash) toast.success('Allowance transaction broadcast.');
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card">
      <h2>Allowance</h2>
      <p className="muted small">
        Let a contract (a DEX router, for example) spend a token. Approvals are simulated and policy-checked; an unlimited approval is refused unless the policy
        allowlists the spender. Revoking sets the allowance back to 0.
      </p>
      <div className="stack-form">
        <div className="grid-2">
          <label>
            <span>Token</span>
            <select value={chosenToken} onChange={(e) => setToken(e.target.value)}>
              {tokens.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Spender</span>
            <select value={chosenSpender} onChange={(e) => setSpender(e.target.value)}>
              {spenders.map((s) => (
                <option key={s.label} value={s.label}>
                  {s.label} · {s.address.slice(0, 10)}…
                </option>
              ))}
              <option value={CUSTOM}>Other address…</option>
            </select>
          </label>
        </div>
        {chosenSpender === CUSTOM && (
          <label>
            <span>Spender address</span>
            <input className="mono" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="0x…" spellCheck={false} />
          </label>
        )}
        <div className="allowance-amount">
          <label>
            <span>Allowance</span>
            <input className="mono" value={unlimited ? 'unlimited' : amount} disabled={unlimited} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />
            <span>Unlimited</span>
          </label>
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={check} disabled={busy || !spenderAddress}>
            {busy ? <Loader2 size={15} className="spin" aria-hidden /> : null} Check tier
          </button>
          <button type="button" className="btn" onClick={send} disabled={busy || !can('transact') || !verdict || verdict.tier === 'T3_DENY' || !spenderAddress}>
            Submit
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setUnlimited(false);
              setAmount('0');
              setVerdict(null);
              setResult(null);
            }}
          >
            Set to 0 (revoke)
          </button>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {verdict && (
        <div className="verdict" role="status">
          <TierBadge tier={verdict.tier} />
          <div>
            <p className="explain">{verdict.explanation}</p>
            <ul className="reasons">
              {verdict.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {result && (
        <div className="verdict" role="status">
          <TierBadge tier={result.tier} />
          <div>
            <p className="explain">{result.status}</p>
            {result.txHash && <p className="small">{linkify(result.txHash, status?.explorer ?? null)}</p>}
            {result.error && <p className="muted small">{result.error}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
