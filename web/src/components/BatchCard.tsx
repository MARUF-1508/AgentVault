import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { announce } from '../a11y';
import { previewBatch, sendBatch, type BatchLine, type BatchTransfer, type TransactResult } from '../api';
import { useAuth } from '../auth';
import { useWallet } from '../data';
import { linkify, TierBadge } from '../format';

const MAX = 10;
const blank = (): BatchTransfer => ({ to: '', amount: '' });

/**
 * Batch payments (T3): several transfers checked together, each line counted
 * toward the next, so a batch cannot slip past the daily budget one small line
 * at a time. If any line would be refused, the server sends nothing.
 */
export default function BatchCard() {
  const { policy, status, refresh } = useWallet();
  const { can } = useAuth();
  const assets = policy ? [policy.native.symbol, ...Object.keys(policy.tokens)] : [];
  const names = [...Object.keys(policy?.recipients.allowlist ?? {}), ...Object.keys(policy?.recipients.contacts ?? {})];
  const [rows, setRows] = useState<BatchTransfer[]>([blank(), blank()]);
  const [lines, setLines] = useState<BatchLine[] | null>(null);
  const [allowed, setAllowed] = useState(false);
  const [results, setResults] = useState<TransactResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const filled = rows.filter((r) => r.to.trim() && r.amount.trim());
  const payload = () =>
    filled.map((r) => ({ to: r.to.trim(), amount: r.amount.trim(), ...(r.token && r.token !== policy?.native.symbol ? { token: r.token } : {}) }));

  const edit = (i: number, patch: Partial<BatchTransfer>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setLines(null);
    setResults(null);
  };

  const check = () => {
    setBusy(true);
    setError('');
    setResults(null);
    previewBatch(payload())
      .then((r) => {
        setLines(r.lines);
        setAllowed(r.allowed);
        announce(r.allowed ? `Batch of ${r.lines.length} allowed.` : 'Batch refused: at least one line breaks the policy.');
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const send = () => {
    setBusy(true);
    setError('');
    sendBatch(payload())
      .then((r) => {
        setResults(r.results);
        const done = r.results.filter((x) => x.status === 'executed' || x.status === 'pending').length;
        toast.message(`${done} of ${r.lines.length} transfers sent${r.stoppedAtLine ? `; stopped at line ${r.stoppedAtLine}` : ''}.`);
        announce(`${done} of ${r.lines.length} transfers sent.`);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };

  return (
    <section className="card" aria-labelledby="batch-title">
      <h2 id="batch-title">Batch payment</h2>
      <p className="muted small">Up to {MAX} transfers, checked together. If any line would be refused, nothing is sent.</p>
      <datalist id="batch-names">
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <ol className="batch-rows">
        {rows.map((r, i) => (
          <li key={i} className="batch-row">
            <label>
              <span className="sr-only">Line {i + 1} recipient</span>
              <input
                value={r.to}
                onChange={(e) => edit(i, { to: e.target.value })}
                placeholder="name or 0x…"
                list="batch-names"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              <span className="sr-only">Line {i + 1} amount</span>
              <input value={r.amount} onChange={(e) => edit(i, { amount: e.target.value })} placeholder="amount" inputMode="decimal" autoComplete="off" />
            </label>
            <label>
              <span className="sr-only">Line {i + 1} asset</span>
              <select value={r.token ?? assets[0] ?? ''} onChange={(e) => edit(i, { token: e.target.value })}>
                {assets.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="ghost icon"
              aria-label={`Remove line ${i + 1}`}
              disabled={rows.length <= 1}
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
            >
              <Trash2 size={15} aria-hidden />
            </button>
            {lines?.[filled.indexOf(r)] && filled.includes(r) && (
              <div className="batch-verdict">
                <TierBadge tier={lines[filled.indexOf(r)]!.tier} />
                <span className="small muted">{lines[filled.indexOf(r)]!.reasons[0]}</span>
              </div>
            )}
            {results?.[filled.indexOf(r)] && filled.includes(r) && (
              <p className="small">
                {results[filled.indexOf(r)]!.status.replace(/_/g, ' ')}
                {results[filled.indexOf(r)]!.txHash && <> · {linkify(results[filled.indexOf(r)]!.txHash!, status?.explorer ?? null)}</>}
              </p>
            )}
          </li>
        ))}
      </ol>
      <div className="row">
        <button type="button" className="ghost small" disabled={rows.length >= MAX} onClick={() => setRows((rs) => [...rs, blank()])}>
          <Plus size={14} aria-hidden /> Add line
        </button>
        <span className="spacer" />
        <button type="button" disabled={busy || filled.length === 0} onClick={check}>
          {busy && <Loader2 size={14} className="spin" aria-hidden />} Check batch
        </button>
        {lines && allowed && can('transact') && (
          <button type="button" className="ghost" disabled={busy} onClick={send}>
            Send batch
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {lines && !allowed && <p className="error">At least one line breaks the policy, so nothing would be sent. Fix it and check again.</p>}
    </section>
  );
}
