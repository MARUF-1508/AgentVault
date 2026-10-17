import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { preview, transact, type TransactResult, type Tier, type TransferIntent } from '../api';
import { useAuth } from '../auth';
import { useWallet } from '../data';
import { linkify, TierBadge } from '../format';

const CUSTOM = '__custom__';

/**
 * Direct path to the executor without the LLM: check a transfer's tier, then
 * optionally submit it. Submitting goes through the same policy, simulation and
 * T2 approval as the agent does.
 */
export default function PolicyCheck() {
  const { policy, status, refresh: onActivity } = useWallet();
  const { can } = useAuth();
  const labels = Object.keys(policy?.recipients.allowlist ?? {});
  const assets = policy ? [policy.native.symbol, ...Object.keys(policy.tokens)] : [];
  const [asset, setAsset] = useState('');
  const [recipient, setRecipient] = useState('');
  const [custom, setCustom] = useState('');
  const [amount, setAmount] = useState('0.0002');
  const [verdict, setVerdict] = useState<{ tier: Tier; reasons: string[] } | null>(null);
  const [result, setResult] = useState<TransactResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const chosenAsset = asset || assets[0] || '';
  const chosenRecipient = recipient || labels[0] || CUSTOM;
  const to = chosenRecipient === CUSTOM ? custom.trim() : (policy?.recipients.allowlist[chosenRecipient] ?? '');

  const intent = (): TransferIntent =>
    chosenAsset === policy?.native.symbol
      ? { kind: 'native_transfer', to, amount: amount.trim() }
      : { kind: 'erc20_transfer', token: chosenAsset, to, amount: amount.trim() };

  const reset = () => {
    setVerdict(null);
    setResult(null);
    setError('');
  };

  const check = (e: FormEvent) => {
    e.preventDefault();
    reset();
    setBusy(true);
    preview(intent())
      .then(setVerdict)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const submit = () => {
    setResult(null);
    setError('');
    setBusy(true);
    transact(intent())
      .then((r) => {
        setResult(r);
        if (r.status === 'executed') toast.success('Transaction confirmed on-chain.');
        else toast.message(`Result: ${r.status.replace(/_/g, ' ')}`);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => {
        setBusy(false);
        onActivity();
      });
  };

  return (
    <section className="card">
      <h2>Check and send</h2>
      <p className="muted small">See which tier a transfer lands in before anything is signed. No model needed.</p>
      <form className="check" onSubmit={check} onChange={reset}>
        <label>
          Amount
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount" />
        </label>
        <label>
          Asset
          <select value={chosenAsset} onChange={(e) => setAsset(e.target.value)}>
            {assets.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className="wide">
          To
          <select value={chosenRecipient} onChange={(e) => setRecipient(e.target.value)}>
            {labels.map((l) => (
              <option key={l} value={l}>
                {l} (allowlisted)
              </option>
            ))}
            <option value={CUSTOM}>Another address…</option>
          </select>
        </label>
        {chosenRecipient === CUSTOM && (
          <label className="wide">
            Address
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="0x…" className="mono" />
          </label>
        )}
        <div className="row wide">
          <button type="submit" disabled={busy || !to}>
            Check tier
          </button>
          {verdict && verdict.tier !== 'T3_DENY' && can('transact') && (
            <button type="button" className="ghost" disabled={busy} onClick={submit}>
              {verdict.tier === 'T1_AUTO' ? 'Send it' : 'Send for approval'}
            </button>
          )}
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      {verdict && (
        <div className={`verdict v-${verdict.tier.slice(0, 2).toLowerCase()}`}>
          <TierBadge tier={verdict.tier} />
          <ul className="reasons">
            {verdict.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {result && (
        <p className={result.status === 'executed' ? 'ok-text' : 'error'}>
          {result.status.replace(/_/g, ' ')}
          {result.txHash && <> · {linkify(result.txHash, status?.explorer ?? null)}</>}
          {result.error && <> · {result.error}</>}
        </p>
      )}
    </section>
  );
}
