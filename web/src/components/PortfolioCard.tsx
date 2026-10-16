import { useEffect, useState } from 'react';
import { getPolicy, getPortfolio, type Policy, type Portfolio } from '../api';

/** Parse "spent of budget" when the policy carries it; otherwise show limits. */
export default function PortfolioCard() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState('');

  const refresh = () => {
    setError('');
    Promise.all([getPortfolio(), getPolicy()])
      .then(([p, pol]) => {
        setPortfolio(p);
        setPolicy(pol);
      })
      .catch((e) => setError((e as Error).message));
  };

  useEffect(refresh, []);

  const budget = (symbol: string): string => {
    const limits =
      symbol === policy?.native.symbol ? policy?.native : policy?.tokens[symbol];
    if (!limits) return '';
    return `auto ≤ ${limits.autoMaxPerTx} · hard cap ${limits.hardMaxPerTx} · ${limits.dailyBudget}/day`;
  };

  return (
    <section className="card">
      <div className="row spread">
        <h2>Portfolio</h2>
        <button onClick={refresh}>Refresh</button>
      </div>
      {error && <p className="error">{error}</p>}
      {portfolio && (
        <>
          <p className="muted">
            {portfolio.address} · {portfolio.chain} · total ≈ ${portfolio.totalUsd}
          </p>
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Balance</th>
                <th>USD</th>
                <th>Budget meter</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.holdings.map((h) => (
                <tr key={h.asset}>
                  <td>{h.asset}</td>
                  <td>{h.balance}</td>
                  <td>
                    {h.usdValue ?? '—'}
                    {h.priceSource && <span className="muted"> ({h.priceSource})</span>}
                  </td>
                  <td className="muted">{budget(h.asset)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
