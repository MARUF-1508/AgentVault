import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { whatIf, type WhatIfResult } from '../api';
import { useWallet } from '../data';
import { TierBadge } from '../format';

/**
 * Read-only "what would happen if …?" (the CLI's `whatif`). The pure engine
 * evaluates the same intent twice; this component can never change the policy,
 * the limits or the pause state.
 */
export default function PolicySimulator() {
  const { policy } = useWallet();
  const assets = policy ? [policy.native.symbol, ...Object.keys(policy.tokens)] : ['ETH'];
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('0.0002');
  const [asset, setAsset] = useState('');
  const [allow, setAllow] = useState(false);
  const [paused, setPaused] = useState(false);
  const [auto, setAuto] = useState('');
  const [hard, setHard] = useState('');
  const [daily, setDaily] = useState('');
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chosen = asset || assets[0]!;
  const native = chosen === policy?.native.symbol;

  const run = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    whatIf({
      to: to.trim(),
      amount: amount.trim(),
      ...(native ? {} : { token: chosen }),
      ...(allow ? { allow: true } : {}),
      ...(paused ? { paused: true } : {}),
      ...(auto.trim() || hard.trim() || daily.trim()
        ? { limits: { ...(auto.trim() ? { autoMaxPerTx: auto.trim() } : {}), ...(hard.trim() ? { hardMaxPerTx: hard.trim() } : {}), ...(daily.trim() ? { dailyBudget: daily.trim() } : {}) } }
        : {}),
    })
      .then(setResult)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card">
      <h2>Policy simulator</h2>
      <p className="muted small">
        Ask “what if …?” without changing anything. Useful before adding a recipient or raising a limit in <code>config/policy.json</code>.
      </p>
      <form className="stack-form" onSubmit={run}>
        <div className="grid-2">
          <label>
            <span>Recipient</span>
            <input className="mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} required />
          </label>
          <label>
            <span>Amount</span>
            <input className="mono" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
          </label>
        </div>
        <label>
          <span>Asset</span>
          <select value={chosen} onChange={(e) => setAsset(e.target.value)}>
            {assets.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <div className="check-list">
          <label className="check-row">
            <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
            <span>Assume this address is allowlisted</span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
            <span>Assume the wallet is paused</span>
          </label>
        </div>
        <details>
          <summary className="muted small">Hypothetical limits (optional)</summary>
          <div className="grid-2">
            <label>
              <span>Auto max per tx</span>
              <input className="mono" value={auto} onChange={(e) => setAuto(e.target.value)} placeholder="unchanged" inputMode="decimal" />
            </label>
            <label>
              <span>Hard max per tx</span>
              <input className="mono" value={hard} onChange={(e) => setHard(e.target.value)} placeholder="unchanged" inputMode="decimal" />
            </label>
            <label>
              <span>Daily budget</span>
              <input className="mono" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="unchanged" inputMode="decimal" />
            </label>
          </div>
        </details>
        <div className="row">
          <button className="btn" type="submit" disabled={busy || !to.trim() || !amount.trim()}>
            {busy ? <Loader2 size={15} className="spin" aria-hidden /> : null} Simulate
          </button>
        </div>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="whatif-result" role="status">
          <p>{result.summary}</p>
          <div className="grid-2">
            <div>
              <p className="muted small">Today</p>
              <p className="row">
                <TierBadge tier={result.baseline.tier} />
              </p>
              <ul className="reasons">
                {result.baseline.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="muted small">Under the hypothesis</p>
              <p className="row">
                <TierBadge tier={result.hypothetical.tier} />
                {result.morePermissive && <span className="badge">more permissive</span>}
              </p>
              <ul className="reasons">
                {result.hypothetical.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
