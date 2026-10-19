import { AnimatePresence, motion } from 'framer-motion';
import { Minimize2, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '../a11y';
import { useApproval } from '../approval';
import { useAuth } from '../auth';
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

export default function ApprovalModal() {
  const { summary, expiresAt, open, hide, answer, busy } = useApproval();
  const { can, me } = useAuth();
  const [now, setNow] = useState(Date.now());
  const [typed, setTyped] = useState('');
  const rejectRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const mayApprove = can('approve');
  // Owners get a real modal: focus stays inside, Escape rejects (the safe answer).
  useFocusTrap(dialogRef, Boolean(summary && open && mayApprove), () => void answer(false));

  // A fresh pending request starts with an empty confirmation field.
  useEffect(() => setTyped(''), [summary]);

  useEffect(() => {
    if (!summary) return;
    const clock = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(clock);
  }, [summary]);

  // Focus the safe choice first, so a stray Enter rejects.
  useEffect(() => {
    if (open && summary) rejectRef.current?.focus();
  }, [open, summary]);

  const f = summary ? parse(summary) : {};
  const left = expiresAt ? Math.max(0, expiresAt - now) : 0;

  // First-time recipients are the risky case, so approving one asks the human to
  // confirm the last four characters of the address instead of a single click.
  const targetMatch = useMemo(() => /0x[0-9a-fA-F]{40}/.exec(f.Target ?? ''), [f.Target]);
  const isNewRecipient = /not on the allowlist/i.test(f.Why ?? '') && targetMatch !== null;
  const last4 = targetMatch ? targetMatch[0].slice(-4).toLowerCase() : '';
  const unlocked = !isNewRecipient || typed.trim().toLowerCase() === last4;

  return (
    <AnimatePresence>
      {summary && open && (
        <motion.div
          // Owners get a blocking dialog; others get a corner card that does not block the page.
          className={mayApprove ? 'overlay' : 'floating'}
          role="dialog"
          aria-modal={mayApprove}
          aria-labelledby="approval-title"
          aria-describedby="approval-desc"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.section
            ref={dialogRef}
            className="card approval"
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          >
            <div className="row spread">
              <h2 id="approval-title" className="row">
                <ShieldAlert size={20} aria-hidden /> {mayApprove ? 'Your approval is needed' : 'Waiting for an owner'}
              </h2>
              <div className="row">
                <TierBadge tier={f.Tier ?? 'T2_CONFIRM'} />
                {mayApprove && (
                  <button className="ghost icon" onClick={hide} title="Minimise. The pill in the top bar brings it back." aria-label="Minimise this approval">
                    <Minimize2 size={16} />
                  </button>
                )}
              </div>
            </div>
            <p className="muted" id="approval-desc">
              The policy engine allows this only with a human's yes. Check the recipient and the decoded call carefully.
            </p>
            <dl className="fields">
              <dt>Action</dt>
              <dd>{(f.Action ?? '').replace(/_/g, ' ')}</dd>
              <dt>Amount</dt>
              <dd className="amount">{f.Amount}</dd>
              {f.Effect && (
                <>
                  <dt>Effect</dt>
                  <dd className="effect">{f.Effect}</dd>
                </>
              )}
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
              {f.Call && (
                <>
                  <dt>Call</dt>
                  <dd className="mono small call" title="Decoded from the exact bytes that will be signed">
                    {f.Call}
                  </dd>
                </>
              )}
              {f.Gas && (
                <>
                  <dt>Gas</dt>
                  <dd className="muted small">{f.Gas}</dd>
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
            {mayApprove ? (
              <>
                {isNewRecipient && (
                  <div className="confirm-address">
                    <label>
                      First time sending to this address. Type its last 4 characters ({typed.trim().length}/4) to unlock approval.
                      <input
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        placeholder="last 4 characters"
                        className="mono"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="Type the last four characters of the target address"
                      />
                    </label>
                  </div>
                )}
                <div className="row end">
                  <button ref={rejectRef} className="reject" disabled={busy} onClick={() => answer(false)}>
                    Reject
                  </button>
                  <button className="approve" disabled={busy || !unlocked} onClick={() => answer(true)}>
                    {isNewRecipient && !unlocked ? 'Type to unlock' : 'Approve and sign'}
                  </button>
                </div>
                <p className="muted small">Approvals need a click. Voice commands can never approve.</p>
              </>
            ) : (
              <p className="notice">Your role ({me?.role}) cannot approve. An owner must decide before it is rejected automatically.</p>
            )}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}