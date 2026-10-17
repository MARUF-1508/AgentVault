import { useAuth } from '../auth';
import PolicyCheck from '../components/PolicyCheck';
import { BudgetMeters } from '../components/Portfolio';
import { useWallet } from '../data';
import { usePageTitle } from '../format';

export default function Transfer() {
  usePageTitle('Transfer');
  const { can, me } = useAuth();
  const { budget } = useWallet();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Transfer</h1>
          <p className="muted">Check which tier a transfer lands in before anything is signed, then send it through the same executor the agent uses.</p>
        </div>
      </div>
      {can('preview') ? (
        <div className="grid-side">
          <PolicyCheck />
          <section className="card">
            <h2>Today's limits</h2>
            <BudgetMeters budget={budget} />
          </section>
        </div>
      ) : (
        <p className="notice">Your role ({me?.role}) is read-only. Ask an owner for operator access to preview or send.</p>
      )}
    </>
  );
}
