import { Anchor, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { anchorAudit, getAnchors, type AnchorReport } from '../api';
import { useAuth } from '../auth';
import { useWallet } from '../data';
import { linkify } from '../format';

/**
 * On-chain audit anchors (the CLI's `audit anchor` / `audit verify --onchain`).
 * Anchoring writes the current head hash into a zero-value transaction; the
 * owner can then check every anchor against the chain from here.
 */
export default function AuditAnchor() {
  const { can } = useAuth();
  const { status, refresh } = useWallet();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ seq: number; txHash?: string; explorerUrl?: string; status: string; error?: string } | null>(null);
  const [report, setReport] = useState<AnchorReport | null>(null);

  const anchor = () => {
    setBusy(true);
    anchorAudit()
      .then((r) => {
        setLast({ seq: r.anchoredSeq, txHash: r.txHash, explorerUrl: r.explorerUrl, status: r.status, error: r.error });
        setConfirming(false);
        if (r.status === 'executed') {
          toast.success(`Audit head #${r.anchoredSeq} anchored on-chain.`);
          refresh();
        } else {
          toast.error(r.error ?? `Anchor ${r.status}.`);
        }
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setBusy(false));
  };

  const verify = () => {
    setBusy(true);
    getAnchors()
      .then((r) => {
        setReport(r);
        if (r.local.ok && r.onchain.ok) toast.success('Local chain and every anchor match.');
        else toast.error('The audit chain or an anchor does not match.');
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card">
      <h2 className="row">
        <Anchor size={18} aria-hidden /> On-chain audit anchors
      </h2>
      <p className="muted small">
        An anchor is a zero-value self-transaction whose calldata carries the latest audit hash. It proves the log existed in this state, even if someone rewrites
        the local file later.
      </p>
      <div className="row">
        {can('admin') &&
          (confirming ? (
            <>
              <span className="muted small">Send a zero-value transaction from the wallet?</span>
              <button className="btn" onClick={anchor} disabled={busy}>
                {busy ? <Loader2 size={15} className="spin" aria-hidden /> : null} Confirm anchor
              </button>
              <button className="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setConfirming(true)}>
              <Anchor size={15} aria-hidden /> Anchor the audit head
            </button>
          ))}
        <button className="ghost" onClick={verify} disabled={busy}>
          Verify anchors on-chain
        </button>
      </div>
      {last && (
        <p className="small" role="status">
          Anchored #{last.seq}: {last.status}
          {last.txHash ? <> · {linkify(last.txHash, status?.explorer ?? null)}</> : null}
          {last.error ? ` — ${last.error}` : ''}
        </p>
      )}
      {report && (
        <div role="status">
          <p className="small">
            Local chain: <strong>{report.local.ok ? 'intact' : `broken at #${report.local.brokenAt}`}</strong>
            {report.note ? ` — ${report.note}` : ''}
          </p>
          {report.onchain.checks.length > 0 && (
            <ul className="step-list">
              {report.onchain.checks.map((c) => (
                <li key={c.txHash}>
                  <span className={`badge ${c.ok ? 'ok' : 'bad'}`}>{c.ok ? 'match' : 'mismatch'}</span>
                  {linkify(c.txHash, status?.explorer ?? null)}
                  <span className="muted small">
                    {c.ok ? `entry #${c.seq}` : c.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="muted small">Anchors cost testnet gas. Only an owner can create one; anyone signed in can verify them.</p>
    </section>
  );
}
