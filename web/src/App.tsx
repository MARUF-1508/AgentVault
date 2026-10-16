import { useState } from 'react';
import ApprovalCard from './components/ApprovalCard';
import AuditTimeline from './components/AuditTimeline';
import ChatPanel from './components/ChatPanel';
import PortfolioCard from './components/PortfolioCard';
import './styles.css';

export default function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <main>
      <h1>Agent Vault</h1>
      <ApprovalCard onDecided={() => setRefreshKey((k) => k + 1)} />
      <div className="grid">
        <ChatPanel />
        <PortfolioCard />
      </div>
      <AuditTimeline refreshKey={refreshKey} />
    </main>
  );
}
