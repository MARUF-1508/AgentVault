import { Download } from 'lucide-react';
import AuditTimeline from '../components/AuditTimeline';
import Reveal from '../components/Reveal';
import { usePageTitle } from '../format';

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
        <a className="btn ghost" href="/api/audit/export" download="agentvault-audit.csv">
          <Download size={16} aria-hidden /> Export CSV
        </a>
      </div>
      <Reveal>
        <AuditTimeline limit={50} />
      </Reveal>
    </>
  );
}
