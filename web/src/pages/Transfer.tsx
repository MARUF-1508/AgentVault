import { useAuth } from '../auth';
import AllowanceForm from '../components/AllowanceForm';
import BatchCard from '../components/BatchCard';
import PolicyCheck from '../components/PolicyCheck';
import SwapForm from '../components/SwapForm';
import X402Card from '../components/X402Card';
import { BudgetMeters } from '../components/Portfolio';
import { useWallet } from '../data';
import { usePageTitle } from '../format';
import { useState } from 'react';
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
  const [mode, setMode] = useState<'send' | 'allowance' | 'swap'>('send');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Transfer</h1>
          <p className="muted">Check which tier a transfer lands in before anything is signed, then send it through the same executor the agent uses.</p>
        </div>
      </div>
      {can('preview') ? (
        <>
          {/* Outside the grid on purpose: as a direct grid child this banner
              took the first column and pushed the form into the sidebar. */}
          {to && (
            <p className="notice grid-note">
              Reviewing <span className="mono">{to}</span> from the Agent page. It is not a known recipient, so expect T2 and an approval step.
            </p>
          )}
          <div className="segmented transfer-tabs" role="tablist" aria-label="Transfer type">
            {(['send', 'allowance', 'swap'] as const).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                {m === 'send' ? 'Send' : m === 'allowance' ? 'Allowance' : 'Swap'}
              </button>
            ))}
          </div>
          <div className="grid-side">
            {mode === 'send' && <PolicyCheck key={`${to}-${amount}-${asset}`} initialTo={to} initialAmount={amount} initialAsset={asset} />}
            {mode === 'allowance' && <AllowanceForm />}
            {mode === 'swap' && <SwapForm />}
            <section className="card">
              <h2>Today's limits</h2>
              <BudgetMeters budget={budget} />
            </section>
            {mode === 'send' && <BatchCard />}
            <X402Card />
          </div>
        </>
      ) : (
        <p className="notice">Your role ({me?.role}) is read-only. Ask an owner for operator access to preview or send.</p>
      )}
    </>
  );
}
