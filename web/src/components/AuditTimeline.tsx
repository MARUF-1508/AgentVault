import { ScrollText } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getActivity, getVerify, type ActivityEntry } from '../api';
import { useWallet } from '../data';
import { linkify, shortAddr, TierBadge, usePoll } from '../format';

interface IntentLike {
  kind?: string;
  amount?: string;
  amountIn?: string;
  token?: string;
  tokenIn?: string;
  tokenOut?: string;
  to?: string;
  spender?: string;
}

function describeIntent(i: IntentLike & { seq?: number }): string {
  const kind = (i.kind ?? 'request').replace(/_/g, ' ');
  if (i.kind === 'audit_anchor') return `anchor audit entry #${i.seq ?? '?'} on-chain`;
  if (i.kind === 'swap') return `swap ${i.amountIn} ${i.tokenIn} to ${i.tokenOut}`;
  const target = i.to ?? i.spender;
  const asset = i.token ?? (i.kind === 'native_transfer' ? 'ETH' : '');
  return `${kind} ${i.amount ?? ''} ${asset}${target ? ` to ${shortAddr(target)}` : ''}`.replace(/\s+/g, ' ');
}

const LABELS: Record<string, string> = {
  intent: 'Request',
  decision: 'Policy',
  simulation: 'Simulation',
  approval: 'Human',
  tx_sent: 'Broadcast',
  tx_confirmed: 'Confirmed',
  tx_failed: 'Failed',
  tx_pending: 'Pending',
  anchor: 'Anchored',
  schedule: 'Schedule',
  kill_switch: 'Kill switch',
  access: 'Access',
};

function detail(e: ActivityEntry, explorer: string | null): ReactNode {
  const d = e.data;
  switch (e.type) {
    case 'intent':
      if (typeof d.batch === 'number') return `batch of ${d.batch} transfers`;
      return describeIntent((d.intent ?? {}) as IntentLike);
    case 'tx_pending':
      return (
        <>
          {linkify(String(d.hash ?? ''), explorer)} · no receipt yet
        </>
      );
    case 'anchor':
      return (
        <>
          entry #{String(d.seq)} committed on-chain · {linkify(String(d.txHash ?? ''), explorer)}
        </>
      );
    case 'decision': {
      const reasons = (d.reasons as string[] | undefined) ?? [];
      return (
        <>
          <TierBadge tier={String(d.tier)} /> {d.recheck ? 're-check: ' : ''}
          {reasons[0] ?? ''}
        </>
      );
    }
    case 'simulation':
      return d.ok ? `passed, ${String(d.gas ?? '?')} gas` : `failed: ${String(d.error ?? '')}`;
    case 'approval':
      return d.approved ? 'approved' : 'rejected';
    case 'tx_sent':
    case 'tx_confirmed':
      return (
        <>
          {linkify(String(d.hash ?? ''), explorer)}
          {d.blockNumber ? ` · block ${String(d.blockNumber)}` : ''}
        </>
      );
    case 'tx_failed':
      return `${String(d.stage ?? '')}: ${String(d.error ?? d.hash ?? '')}`;
    case 'kill_switch':
      return `${d.paused ? 'paused' : 'resumed'}${d.by ? ` from the ${String(d.by)}` : ''}${d.user ? ` by ${String(d.user)}` : ''}`;
    case 'access': {
      // Access covers sign-in and every owner-only change; a missing user (a
      // failed login for an unknown name) or a missing 'ok' must not render
      // as the literal string "undefined".
      const who = String(d.user ?? d.by ?? 'unknown');
      switch (d.event) {
        case 'decide':
          if (d.channel === 'telegram' && d.ok === false) return 'ignored a Telegram button press (wrong chat or stale request)';
          if (d.channel === 'email' && d.ok === false) return `refused an email approval link${d.reason ? ` (${String(d.reason)})` : ' (request no longer waiting)'}`;
          return `${who} ${d.approved ? 'approved' : 'rejected'} a T2 request${d.channel === 'telegram' ? ' via Telegram' : d.channel === 'email' ? ' via an email link' : ''}`;
        case 'approval_emailed':
          return 'approval request emailed to the owner';
        case 'approval_email_failed':
          return 'could not email the approval request (web approval still works)';
        case 'contact_added':
          return `${who} added ${String(d.label ?? 'a contact')} to the address book`;
        case 'contact_removed':
          return `${who} removed ${String(d.label ?? 'a contact')} from the address book`;
        case 'policy_loaded':
          return `server started with policy ${String(d.policyHash ?? '').slice(0, 16)}${d.pinned ? ' (pinned)' : ''}`;
        case 'compliance_export':
          return `${who} exported the compliance report`;
        case 'login':
        case 'sign_in':
          return `${who} sign-in ${d.ok ? 'succeeded' : 'failed'}${d.reason ? ` (${String(d.reason).replace(/_/g, ' ')})` : ''}`;
        case 'setup':
          return `${who} created the owner account`;
        case 'totp_setup_started':
          return `${who} started two-factor setup`;
        case 'totp_enabled':
          return `${who} turned on two-factor${d.revoked ? ` (${String(d.revoked)} other session(s) signed out)` : ''}`;
        case 'totp_disabled':
          return `${who} turned off two-factor`;
        case 'sessions_revoked':
          return `${who} signed out ${String(d.revoked ?? '')} other session(s)`.replace('  ', ' ');
        case 'user_added':
          return `${who} added ${String(d.user ?? 'an account')} as ${String(d.role ?? 'member')}`;
        case 'user_removed':
          return `${who} removed ${String(d.user ?? 'an account')}`;
        case 'recipient_added':
          return `${who} allowlisted ${String(d.label ?? d.address ?? 'a recipient')}`;
        case 'recipient_removed':
          return `${who} removed ${String(d.label ?? d.address ?? 'a recipient')} from the allowlist`;
        case 'deny_added':
          return `${who} denied ${shortAddr(String(d.address ?? ''))}`;
        case 'deny_removed':
          return `${who} un-denied ${shortAddr(String(d.address ?? ''))}`;
        default:
          return `${who} ${String(d.event ?? 'access').replace(/_/g, ' ')}`;
      }
    }
    default:
      return JSON.stringify(d).slice(0, 80);
  }
}

const FILTERS: Record<string, (e: ActivityEntry) => boolean> = {
  All: () => true,
  'On-chain': (e) => e.type.startsWith('tx_'),
  Refused: (e) => e.type === 'decision' && e.data.tier === 'T3_DENY',
  'Human decisions': (e) => e.type === 'approval' || e.type === 'kill_switch' || e.type === 'access',
};

export default function AuditTimeline({ limit = 50, compact = false }: { limit?: number; compact?: boolean }) {
  const { refreshKey, status } = useWallet();
  const explorer = status?.explorer ?? null;
  const [entries] = usePoll(() => getActivity(limit), 5_000, [refreshKey, limit]);
  const [verify] = usePoll(getVerify, 10_000, [refreshKey]);
  const [filter, setFilter] = useState('All');
  const shown = (entries ?? []).filter(FILTERS[filter]!).reverse();

  return (
    <section className="card">
      <div className="row spread wrap">
        <h2>{compact ? 'Recent activity' : 'Audit trail'}</h2>
        <div className="row wrap">
          {!compact && (
          <div className="segmented" role="tablist">
            {Object.keys(FILTERS).map((f) => (
              <button key={f} role="tab" aria-selected={f === filter} className={f === filter ? 'on' : ''} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
          </div>
          )}
          <span
            className={verify === null ? 'badge' : verify.ok ? 'badge ok' : 'badge bad'}
            title="Every entry commits to the previous one by SHA-256, so an edit anywhere breaks the chain"
          >
            {verify === null ? 'Checking…' : verify.ok ? 'Hash chain intact' : `Tampered at entry ${verify.brokenAt}`}
          </span>
        </div>
      </div>
      {entries === null ? (
        <div className="tl-skeleton" aria-label="Loading activity">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 34, marginTop: '0.5rem', opacity: 1 - i * 0.18 }} />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-state center">
          <ScrollText size={22} className="muted" aria-hidden />
          <p className="muted">
            {filter === 'All' ? 'No activity yet. Every intent, decision and transaction will show up here.' : `Nothing under “${filter}”.`}
          </p>
          {filter === 'All' && !compact && (
            <Link className="btn ghost small" to="/transfer">
              Preview a transfer
            </Link>
          )}
        </div>
      ) : (
        <ol className={`timeline ${compact ? 'compact' : ''}`}>
          {shown.map((e) => (
            <li key={e.seq} className={`t-${e.type}`}>
              <span className="seq muted mono">#{e.seq}</span>
              <span className="time muted small">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="kind">{LABELS[e.type] ?? e.type}</span>
              <span className="detail">{detail(e, explorer)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
