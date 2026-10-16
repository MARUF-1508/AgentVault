import { useEffect, useState } from 'react';
import { decide, getPending } from '../api';

export default function ApprovalCard({ onDecided }: { onDecided: () => void }) {
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => {
      getPending()
        .then((r) => setPending(r.pending))
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, []);

  if (!pending) return null;

  const answer = (approved: boolean) => {
    decide(approved)
      .then(() => {
        setPending(null);
        onDecided();
      })
      .catch(() => {});
  };

  return (
    <section className="card approval">
      <h2>⚠️ Approval required (T2)</h2>
      <pre>{pending}</pre>
      <div className="row">
        <button className="approve" onClick={() => answer(true)}>Approve</button>
        <button className="reject" onClick={() => answer(false)}>Reject</button>
      </div>
    </section>
  );
}
