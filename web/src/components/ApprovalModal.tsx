import { useEffect, useRef, useState } from 'react';
import { decide, getPending } from '../api';
import { splitReasons, TierBadge } from '../format';

/** Matches the WebApprover default in src/approval/approver.ts. */
const WINDOW_MS = 120_000;

/** Parses the executor's "  Key : value" summary into fields. */
function parse(summary: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of summary.split('\n')) {
    const m = /^\s*([A-Za-z ]+?)\s*:\s*(.*)$/.exec(line);
    if (m) out[m[1]!.trim()] = m[2]!.trim();
  }
  return out;
}

/** Shows an address in groups of four so a lookalike (poisoned) address stands out. */
function AddressBlocks({ value }: { value: string }) {
  const m = /^(.*?)(0x[0-9a-fA-F]{40})(.*)$/.exec(value);
  if (!m) return <span className="mono">{value}</span>;
  const groups = m[2]!.slice(2).match(/.{4}/g) ?? [];
  return (
    <span>
      {m[1]}
      <span className="addr-blocks mono">
        <span className="addr-edge">0x</span>
        {groups.map((g, i) => (
          <span key={i} className={i === 0 || i === groups.length - 1 ? 'addr-edge' : ''}>
            {g}
          </span>
        ))}
      </span>
      {m[3]}
    </span>
  );
}

export default function ApprovalModal({ onDecided }: { onDecided: () => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const rejectRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const poll = () =>
      getPending()
        .then((r) => {
          setPending(r.pending);
          setExpiresAt(r.expiresAt);
        })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 1500);
    const clock = setInterval(() => setNow(Date.now()), 500);
    return () => {
      clearInterval(t);
      clearInterval(clock);
    };
  }, []);

  // Focus the safe choice first, so a stray Enter rejects.
  useEffect(() => {
    if (pending) rejectRef.current?.focus();
  }, [pending]);

  if (!pending) return null;
  const f = parse(pending);
  const left = expiresAt ? Math.max(0, expiresAt - now) : 0;

  const answer = (approved: boolean) => {
    setBusy(true);
    decide(approved)
      .then(() => {
        setPending(null);
        onDecided();
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-title"
      onKeyDown={(e) => e.key === 'Escape' && answer(false)}
    >
      <section className="card approval">
        <div className="row spread">
          <h2 id="approval-title">Your approval is needed</h2>
          <TierBadge tier={f.Tier ?? 'T2_CONFIRM'} />
        </div>
        <p className="muted">The policy engine allows this only with a human's yes. Check the recipient carefully.</p>
        <dl className="fields">
          <dt>Action</dt>
          <dd>{(f.Action ?? '').replace(/_/g, ' ')}</dd>
          <dt>Amount</dt>
          <dd className="amount">{f.Amount}</dd>
          <dt>Target</dt>
          <dd>
            <AddressBlocks value={f.Target ?? ''} />
          </dd>
          {f.Via && (
            <>
              <dt>Via</dt>
              <dd>
                <AddressBlocks value={f.Via} />
              </dd>
            </>
          )}
          {f['Min out'] && (
            <>
              <dt>Min out</dt>
              <dd>{f['Min out']}</dd>
            </>
          )}
          <dt>Chain</dt>
          <dd>{f.Chain}</dd>
        </dl>
        <h3>Why it needs you</h3>
        <ul className="reasons">
          {splitReasons(f.Why ?? '').map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        {expiresAt && (
          <div className="countdown" title="Unanswered requests are rejected automatically">
            <div className="bar">
              <span style={{ width: `${(left / WINDOW_MS) * 100}%` }} />
            </div>
            <span className="muted small">Rejected automatically in {Math.ceil(left / 1000)}s</span>
          </div>
        )}
        <div className="row end">
          <button ref={rejectRef} className="reject" disabled={busy} onClick={() => answer(false)}>
            Reject
          </button>
          <button className="approve" disabled={busy} onClick={() => answer(true)}>
            Approve and sign
          </button>
        </div>
      </section>
    </div>
  );
}
