import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { fetchPaid } from '../api';
import { useAuth } from '../auth';
import { useWallet } from '../data';

/**
 * The CLI's `x402`: fetch a paid API resource and let the wallet pay when the
 * endpoint answers 402. The server only allows the configured X402_API_URL
 * origin, so this card cannot be used as an open proxy.
 */
export default function X402Card() {
  const { status, refresh } = useWallet();
  const { can } = useAuth();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<unknown>(null);

  if (!status?.x402) return null;

  const run = () => {
    setBusy(true);
    fetchPaid(url.trim() || undefined)
      .then((r) => {
        setAnswer(r);
        toast.success('Paid API answered.');
        refresh();
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card">
      <h2>Paid API (x402)</h2>
      <p className="muted small">Fetch a resource that answers 402 Payment Required. The wallet pays through the executor; the policy still checks the amount.</p>
      <div className="stack-form">
        <label>
          <span>URL (optional; defaults to X402_API_URL)</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={status.explorer ? 'https://…' : 'configured paid API'} />
        </label>
        <button className="btn" onClick={run} disabled={busy || !can('transact')}>
          {busy ? <Loader2 size={15} className="spin" aria-hidden /> : null} Fetch and pay if asked
        </button>
      </div>
      {answer !== null && (
        <pre className="json-out mono small" aria-live="polite">
          {JSON.stringify(answer, null, 2)}
        </pre>
      )}
    </section>
  );
}
