import AuditTimeline from '../components/AuditTimeline';
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
      </div>
      <AuditTimeline limit={50} />
    </>
  );
}
