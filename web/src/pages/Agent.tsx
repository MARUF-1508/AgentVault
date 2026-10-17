import { Lock, Mic, ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth';
import ChatPanel from '../components/ChatPanel';
import { usePageTitle } from '../format';

export default function Agent() {
  usePageTitle('Agent');
  const { can, me } = useAuth();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agent</h1>
          <p className="muted">Type or speak a goal. The agent plans tool calls; the policy engine decides each one.</p>
        </div>
      </div>
      {can('chat') ? (
        <div className="grid-side">
          <ChatPanel />
          <aside className="card tips">
            <h2>How it stays safe</h2>
            <ul className="icon-list">
              <li>
                <ShieldCheck size={16} aria-hidden /> The agent cannot change limits, allowlists or the kill switch. It has no tool for them.
              </li>
              <li>
                <Lock size={16} aria-hidden /> Tool output is treated as untrusted data, so a token memo cannot give it orders.
              </li>
              <li>
                <Mic size={16} aria-hidden /> Voice only types for you. Approving a T2 always needs an owner's click.
              </li>
            </ul>
            <p className="muted small">Speech recognition runs in your browser (Chrome or Edge work best). Audio is never sent to the wallet server.</p>
          </aside>
        </div>
      ) : (
        <p className="notice">Your role ({me?.role}) can read the wallet but cannot chat with the agent. Ask an owner for operator access.</p>
      )}
    </>
  );
}
