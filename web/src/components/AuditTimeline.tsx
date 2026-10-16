import { useEffect, useState } from 'react';
import { getActivity, getVerify, type ActivityEntry } from '../api';

function short(data: Record<string, unknown>): string {
  if (typeof data.hash === 'string') return (data.hash as string).slice(0, 12) + '…';
  if (typeof data.tier === 'string') return data.tier as string;
  if (typeof data.approved === 'boolean') return data.approved ? 'approved' : 'rejected';
  const intent = data.intent as { kind?: string; amount?: string } | undefined;
  if (intent?.kind) return `${intent.kind} ${intent.amount ?? ''}`.trim();
  return '';
}

export default function AuditTimeline({ refreshKey }: { refreshKey: number }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [intact, setIntact] = useState<boolean | null>(null);

  useEffect(() => {
    getActivity(20)
      .then(setEntries)
      .catch(() => {});
    getVerify()
      .then((v) => setIntact(v.ok))
      .catch(() => setIntact(false));
  }, [refreshKey]);

  return (
    <section className="card">
      <div className="row spread">
        <h2>Audit timeline</h2>
        <span className={intact === null ? 'muted' : intact ? 'badge ok' : 'badge bad'}>
          {intact === null ? '…' : intact ? '✅ chain intact' : '❌ tampered'}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Time</th>
            <th>Type</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.seq}>
              <td>{e.seq}</td>
              <td className="muted">{new Date(e.ts).toLocaleTimeString()}</td>
              <td>{e.type}</td>
              <td className="muted">{short(e.data)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
