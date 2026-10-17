import { useState, type ReactNode } from 'react';
import { getActivity, getVerify, type ActivityEntry } from '../api';
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

function describeIntent(i: IntentLike): string {
  const kind = (i.kind ?? 'request').replace(/_/g, ' ');
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
  schedule: 'Schedule',
  kill_switch: 'Kill switch',
};

function detail(e: ActivityEntry, explorer: string | null): ReactNode {
  const d = e.data;
  switch (e.type) {
    case 'intent':
      return describeIntent((d.intent ?? {}) as IntentLike);
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
      return `${d.paused ? 'paused' : 'resumed'}${d.by ? ` from the ${String(d.by)}` : ''}`;
    default:
      return JSON.stringify(d).slice(0, 80);
  }
}

const FILTERS: Record<string, (e: ActivityEntry) => boolean> = {
  All: () => true,
  'On-chain': (e) => e.type.startsWith('tx_'),
  Refused: (e) => e.type === 'decision' && e.data.tier === 'T3_DENY',
  'Human decisions': (e) => e.type === 'approval' || e.type === 'kill_switch',
};

export default function AuditTimeline({ refreshKey, explorer }: { refreshKey: number; explorer: string | null }) {
  const [entries] = usePoll(() => getActivity(50), 5_000, [refreshKey]);
  const [verify] = usePoll(getVerify, 10_000, [refreshKey]);
  const [filter, setFilter] = useState('All');
  const shown = (entries ?? []).filter(FILTERS[filter]!).reverse();

  return (
    <section className="card">
      <div className="row spread wrap">
        <h2>Audit trail</h2>
        <div className="row wrap">
          <div className="segmented" role="tablist">
            {Object.keys(FILTERS).map((f) => (
              <button key={f} role="tab" aria-selected={f === filter} className={f === filter ? 'on' : ''} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
          </div>
          <span
            className={verify === null ? 'badge' : verify.ok ? 'badge ok' : 'badge bad'}
            title="Every entry commits to the previous one by SHA-256, so an edit anywhere breaks the chain"
          >
            {verify === null ? 'Checking…' : verify.ok ? 'Hash chain intact' : `Tampered at entry ${verify.brokenAt}`}
          </span>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="muted">Nothing here yet.</p>
      ) : (
        <ol className="timeline">
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
