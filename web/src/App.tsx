import { useState } from 'react';
import { getBudget, getPolicy, getStatus } from './api';
import ApprovalModal from './components/ApprovalModal';
import AuditTimeline from './components/AuditTimeline';
import ChatPanel from './components/ChatPanel';
import Header from './components/Header';
import PolicyCheck from './components/PolicyCheck';
import PortfolioCard from './components/PortfolioCard';
import { usePoll } from './format';
import './styles.css';

export default function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);
  const [status, statusError] = usePoll(getStatus, 5_000, [refreshKey]);
  const [budget] = usePoll(getBudget, 10_000, [refreshKey]);
  const [policy] = usePoll(getPolicy, 60_000);

  return (
    <>
      <Header status={status} onChange={bump} />
      <main>
        {statusError && !status && (
          <p className="notice">
            Cannot reach the wallet server ({statusError}). Start it with <code>npm run cli -- serve</code>.
          </p>
        )}
        {status?.paused && (
          <p className="notice bad">The kill switch is on, so every transaction is refused. Run <code>npm run cli -- resume</code> to turn it off.</p>
        )}
        <div className="grid">
          <ChatPanel status={status} onActivity={bump} />
          <div className="stack">
            <PortfolioCard budget={budget} refreshKey={refreshKey} />
            <PolicyCheck policy={policy} status={status} onActivity={bump} />
          </div>
        </div>
        <AuditTimeline refreshKey={refreshKey} explorer={status?.explorer ?? null} />
      </main>
      <ApprovalModal onDecided={bump} />
    </>
  );
}
