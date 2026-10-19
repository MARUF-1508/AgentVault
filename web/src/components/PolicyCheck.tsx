import { Lightbulb, Loader2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { announce } from '../a11y';
import { getTxStatus, preview, transact, type TransactResult, type TransferIntent, type TxStatus, type Verdict } from '../api';
import { useAuth } from '../auth';
import { useWallet } from '../data';
import { linkify, TierBadge } from '../format';

const CUSTOM = '__custom__';

export interface PolicyCheckProps {
  /** Prefilled when the Agent page hands a new recipient over for review. */
  initialTo?: string;
  initialAmount?: string;
  initialAsset?: string;
}

/**
 * Direct path to the executor without the LLM: check a transfer's tier, then
 * optionally submit it. Submitting goes through the same policy, simulation and
 * T2 approval as the agent does.
 */
export default function PolicyCheck({ initialTo, initialAmount, initialAsset }: PolicyCheckProps = {}) {
  const { policy, status, refresh: onActivity } = useWallet();
  const { can } = useAuth();
  const labels = Object.keys(policy?.recipients.allowlist ?? {});
  const contacts = policy?.recipients.contacts ?? {};
  const contactLabels = Object.keys(contacts);
  const assets = policy ? [policy.native.symbol, ...Object.keys(policy.tokens)] : [];
  const [asset, setAsset] = useState(initialAsset ?? '');
  const [recipient, setRecipient] = useState(initialTo ? CUSTOM : '');
  const [custom, setCustom] = useState(initialTo ?? '');
  const [amount, setAmount] = useState(initialAmount ?? '0.0002');
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [result, setResult] = useState<TransactResult | null>(null);
  const [tx, setTx] = useState<TxStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const chosenAsset = asset || assets[0] || '';
  const chosenRecipient = recipient || labels[0] || CUSTOM;
  const to =
    chosenRecipient === CUSTOM
      ? custom.trim()
      : chosenRecipient.startsWith('contact:')
        ? (contacts[chosenRecipient.slice(8)] ?? '')
        : (policy?.recipients.allowlist[chosenRecipient] ?? '');

  // A broadcast that has no receipt yet is followed until it settles (T4).
  useEffect(() => {
    const hash = result?.txHash;
    if (!hash || result?.status !== 'pending') return;
    let alive = true;
    const t = setInterval(() => {
      getTxStatus(hash)
        .then((s) => {
          if (!alive) return;
          setTx(s);
          if (s.status !== 'pending') {
            clearInterval(t);
            announce(`Transaction ${s.status}.`);
            onActivity();
          }
        })
        .catch(() => {});
    }, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.txHash, result?.status]);

  const intent = (): TransferIntent =>
    chosenAsset === policy?.native.symbol
      ? { kind: 'native_transfer', to, amount: amount.trim() }
      : { kind: 'erc20_transfer', token: chosenAsset, to, amount: amount.trim() };

  const reset = () => {
    setVerdict(null);
    setResult(null);
    setTx(null);
    setError('');
  };

  const check = (e: FormEvent) => {
    e.preventDefault();
    reset();
    setBusy(true);
    preview(intent())
      .then((v) => {
        setVerdict(v);
        announce(`Policy verdict: ${v.tier.replace('_', ' ')}. ${v.explanation ?? ''}`);
      })
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
        announce(`Result: ${r.status.replace(/_/g, ' ')}.`);
        if (r.status === 'executed') toast.success('Transaction confirmed on-chain.');
        else if (r.status === 'pending') toast.message('Broadcast. Waiting for the receipt…');
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
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoComplete="off" />
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
            {contactLabels.map((l) => (
              <option key={`c-${l}`} value={`contact:${l}`}>
                {l} (address book, needs approval)
              </option>
            ))}
            <option value={CUSTOM}>Another address…</option>
          </select>
        </label>
        {chosenRecipient === CUSTOM && (
          <label className="wide">
            Address
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="0x…" className="mono" autoComplete="off" spellCheck={false} />
          </label>
        )}
        <div className="row wide">
          <button type="submit" disabled={busy || !to}>
            {busy && <Loader2 size={14} className="spin" aria-hidden />}
            Check tier
          </button>
          {verdict && verdict.tier !== 'T3_DENY' && can('transact') && (
            <button type="button" className="ghost" disabled={busy} onClick={submit}>
              {busy && <Loader2 size={14} className="spin" aria-hidden />}
              {verdict.tier === 'T1_AUTO' ? 'Send it' : 'Send for approval'}
            </button>
          )}
        </div>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {verdict && (
        <div className={`verdict v-${verdict.tier.slice(0, 2).toLowerCase()}`}>
          <TierBadge tier={verdict.tier} />
          <div>
            {verdict.explanation && <p className="small explain">{verdict.explanation}</p>}
            <ul className="reasons">
              {verdict.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {verdict?.alternative && (
        <div className="alternative" role="note">
          <Lightbulb size={16} aria-hidden />
          <div>
            <p className="small">
              <strong>{verdict.alternative.available ? 'Compliant alternative' : 'No compliant amount'}:</strong> {verdict.alternative.note}
            </p>
            {verdict.alternative.available && verdict.alternative.intent && (
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  setAmount(verdict.alternative!.intent!.amount);
                  setVerdict(null);
                  announce(`Amount set to ${verdict.alternative!.intent!.amount}. Check the tier again.`);
                }}
              >
                Use {verdict.alternative.intent.amount} {chosenAsset}
              </button>
            )}
          </div>
        </div>
      )}
      {result && (
        <p className={result.status === 'executed' || (result.status === 'pending' && tx?.status !== 'reverted') ? 'ok-text' : 'error'}>
          {(tx?.status && tx.status !== 'unknown' ? tx.status : result.status).replace(/_/g, ' ')}
          {tx?.confirmations !== undefined && <> · {tx.confirmations} confirmations</>}
          {result.txHash && <> · {linkify(result.txHash, status?.explorer ?? null)}</>}
          {result.error && result.status !== 'pending' && <> · {result.error}</>}
        </p>
      )}
    </section>
  );
}
