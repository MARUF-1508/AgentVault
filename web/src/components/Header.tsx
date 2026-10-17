import { useState } from 'react';
import { pause, type Status } from '../api';
import { CopyButton, shortAddr } from '../format';

export default function Header({ status, onChange }: { status: Status | null; onChange: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');

  const doPause = () => {
    pause()
      .then(() => {
        setConfirming(false);
        onChange();
      })
      .catch((e: Error) => setError(e.message));
  };

  return (
    <header className="topbar">
      <div className="brand">
        <img src="/favicon.png" alt="" width={32} height={32} />
        <div>
          <h1>Agent Vault</h1>
          <p className="muted small">The AI plans. The policy decides. The chain enforces.</p>
        </div>
      </div>
      {status && (
        <div className="pills">
          <span className="pill" title={`Chain ID ${status.chainId}`}>
            <span className="dot ok" /> {status.chain}
          </span>
          {status.address && (
            <span className="pill mono" title={status.address}>
              {shortAddr(status.address)} <CopyButton value={status.address} />
            </span>
          )}
          <span
            className={`pill ${status.vault ? 'pill-good' : ''}`}
            title={status.vault ?? 'Native transfers are signed directly by the agent key'}
          >
            {status.vault ? 'Vault mode: on-chain caps' : 'Direct (EOA) mode'}
          </span>
          <span className="pill" title="Model used by the chat panel">
            {status.llm ? `Model: ${status.model}` : 'No model configured'}
          </span>
          {status.paused ? (
            <span className="pill pill-bad" title="Resume from the CLI: npm run cli -- resume">
              <span className="dot bad" /> Paused: every transaction is refused
            </span>
          ) : confirming ? (
            <span className="pill pill-bad">
              Refuse every transaction until resumed from the CLI?
              <button className="danger small" onClick={doPause}>
                Pause
              </button>
              <button className="ghost small" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button className="danger" onClick={() => setConfirming(true)} title="Kill switch. Resuming is CLI-only.">
              Pause wallet
            </button>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </header>
  );
}
