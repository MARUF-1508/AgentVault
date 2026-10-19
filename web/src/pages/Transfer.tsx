import { useAuth } from '../auth';
import BatchCard from '../components/BatchCard';
import PolicyCheck from '../components/PolicyCheck';
import { BudgetMeters } from '../components/Portfolio';
import { useWallet } from '../data';
import { usePageTitle } from '../format';
import { useSearchParams } from 'react-router-dom';

export default function Transfer() {
  usePageTitle('Transfer');
  const { can, me } = useAuth();
  const { budget } = useWallet();
  // The Agent page sends an unlisted address here to be reviewed; the form is
  // prefilled from the query string. The key remounts it if you land here twice.
  const [params] = useSearchParams();
  const to = params.get('to') ?? undefined;
  const amount = params.get('amount') ?? undefined;
  const asset = params.get('asset') ?? undefined;
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
          {to && (
            <p className="notice">
              Reviewing <span className="mono">{to}</span> from the Agent page. It is not a known recipient, so expect T2 and an approval step.
            </p>
          )}
          <PolicyCheck key={`${to}-${amount}-${asset}`} initialTo={to} initialAmount={amount} initialAsset={asset} />
          <section className="card">
            <h2>Today's limits</h2>
            <BudgetMeters budget={budget} />
          </section>
          <BatchCard />
        </div>
      ) : (
        <p className="notice">Your role ({me?.role}) is read-only. Ask an owner for operator access to preview or send.</p>
      )}
    </>
  );
}
