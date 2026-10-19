import { Download, FileCheck2, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getPendingTxs, getTxStatus, type TxStatus } from '../api';
import AuditTimeline from '../components/AuditTimeline';
import Reveal from '../components/Reveal';
import { useWallet } from '../data';
import { linkify, usePageTitle, usePoll } from '../format';

/** Broadcast transactions still waiting for a receipt, followed until they settle (T4). */
function PendingTxs() {
  const { refreshKey, status, refresh } = useWallet();
  const [pending] = usePoll(getPendingTxs, 8_000, [refreshKey]);
  const [states, setStates] = useState<Record<string, TxStatus>>({});
  const hashes = pending?.pending.map((p) => p.hash) ?? [];

  useEffect(() => {
    if (hashes.length === 0) return;
    let alive = true;
    Promise.all(hashes.map((h) => getTxStatus(h).catch(() => null))).then((list) => {
      if (!alive) return;
      const next: Record<string, TxStatus> = {};
      for (const s of list) if (s) next[s.hash] = s;
      setStates(next);
      if (list.some((s) => s && s.status !== 'pending')) refresh();
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hashes.join(',')]);

  if (!pending || pending.pending.length === 0) return null;
  return (
    <section className="card" aria-labelledby="pending-title">
      <h2 id="pending-title" className="row">
        <Loader2 size={16} className="spin" aria-hidden /> Waiting for confirmation
      </h2>
      <ul className="pending-list" aria-live="polite">
        {pending.pending.map((p) => (
          <li key={p.hash}>
            <span className={`badge ${states[p.hash]?.status === 'reverted' ? 'bad' : ''}`}>{states[p.hash]?.status ?? 'pending'}</span>{' '}
            {linkify(p.hash, status?.explorer ?? null)} <span className="muted small">sent {new Date(p.sentAt).toLocaleTimeString()}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Activity() {
  usePageTitle('Activity');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="muted">
            Every request, policy verdict, approval and transaction, in order. Each entry commits to the one before it, so an edit anywhere breaks the chain.
          </p>
        </div>
        <div className="row">
          <a className="btn ghost" href="/api/audit/export" download="agentvault-audit.csv">
            <Download size={16} aria-hidden /> Export CSV
          </a>
          <a
            className="btn ghost"
            href="/api/compliance"
            download="agentvault-compliance.json"
            title="Decisions, approvals, transactions, access events, integrity and on-chain anchors in one JSON report"
          >
            <FileCheck2 size={16} aria-hidden /> Compliance report
          </a>
        </div>
      </div>
      <PendingTxs />
      <Reveal>
        <AuditTimeline limit={50} />
      </Reveal>
    </>
  );
}
