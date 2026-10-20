import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { executeSwap, swapQuote, type SwapQuote, type SwapStep } from '../api';
import { useAuth } from '../auth';
import { useWallet } from '../data';
import { linkify, TierBadge } from '../format';

/**
 * The CLI's `swap`: quote, then the same bounded approval-then-swap
 * orchestration the agent uses. The approval is exactly the input amount and
 * is only sent after the swap itself passes the policy (T3 swaps leave nothing).
 */
export default function SwapForm() {
  const { policy, status, refresh } = useWallet();
  const { can } = useAuth();
  const tokens = Object.keys(policy?.tokens ?? {});
  const [tokenIn, setTokenIn] = useState('');
  const [tokenOut, setTokenOut] = useState('');
  const [amountIn, setAmountIn] = useState('0.0005');
  const [slippage, setSlippage] = useState('');
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [steps, setSteps] = useState<SwapStep[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!policy?.swap) {
    return <p className="notice">Swaps are not enabled in this policy. Add a `swap` block to `config/policy.json` to turn them on.</p>;
  }
  if (tokens.length < 2) {
    return <p className="notice">Swaps need at least two ERC-20 tokens in the policy.</p>;
  }

  const chosenIn = tokenIn || tokens[0]!;
  const chosenOut = tokenOut || tokens.find((t) => t !== chosenIn) || tokens[1]!;
  const bps = slippage.trim() ? Number(slippage) : undefined;

  const request = () => ({ tokenIn: chosenIn, tokenOut: chosenOut, amountIn: amountIn.trim(), ...(bps !== undefined ? { slippageBps: bps } : {}) });

  const getQuote = () => {
    setBusy(true);
    setError('');
    setSteps(null);
    swapQuote(request())
      .then((q) => {
        if (q.error) setError(q.error);
        else setQuote(q);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const run = () => {
    setBusy(true);
    setError('');
    executeSwap(request())
      .then((r) => {
        setSteps(r.steps ?? null);
        if (r.error) setError(r.error);
        else {
          toast.success('Swap flow finished.');
          refresh();
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card">
      <h2>Swap</h2>
      <p className="muted small">
        Quotes come from the policy DEX. A swap above the auto limit needs an owner approval; the maximum slippage is capped by the policy.
      </p>
      <div className="stack-form">
        <div className="grid-2">
          <label>
            <span>From</span>
            <select
              value={chosenIn}
              onChange={(e) => {
                setTokenIn(e.target.value);
                setQuote(null);
              }}
            >
              {tokens.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>To</span>
            <select
              value={chosenOut}
              onChange={(e) => {
                setTokenOut(e.target.value);
                setQuote(null);
              }}
            >
              {tokens.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid-2">
          <label>
            <span>Amount in</span>
            <input className="mono" value={amountIn} onChange={(e) => setAmountIn(e.target.value)} inputMode="decimal" />
          </label>
          <label>
            <span>Slippage (bps, optional)</span>
            <input
              className="mono"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
              placeholder={`auto (${policy.swap.autoMaxSlippageBps})`}
              inputMode="numeric"
            />
          </label>
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={getQuote} disabled={busy || chosenIn === chosenOut || !amountIn.trim()}>
            {busy ? <Loader2 size={15} className="spin" aria-hidden /> : null} Quote
          </button>
          <button type="button" className="btn" onClick={run} disabled={busy || !can('transact') || chosenIn === chosenOut || !amountIn.trim()}>
            Swap
          </button>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {quote && !quote.error && (
        <div className="verdict" role="status">
          <p>
            {quote.amountIn} {quote.tokenIn} → <strong>{quote.amountOut}</strong> {quote.tokenOut}
          </p>
          <p className="muted small">
            Minimum out at {quote.slippageBps} bps: <span className="mono">{quote.minAmountOut}</span>
          </p>
        </div>
      )}
      {steps && (
        <ul className="step-list" role="status">
          {steps.map((s, i) => (
            <li key={i}>
              <span className={`badge ${s.status === 'denied' || s.error ? 'bad' : s.status === 'executed' || s.status === 'skipped' ? 'ok' : ''}`}>{s.step}</span>
              {s.tier && <TierBadge tier={s.tier} />}
              <span>{s.status}</span>
              {s.reason && <span className="muted small">{s.reason}</span>}
              {s.error && <span className="muted small">{s.error}</span>}
              {s.txHash && <span>{linkify(s.txHash, status?.explorer ?? null)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
