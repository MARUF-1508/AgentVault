import { getPortfolio, type Budget } from '../api';
import { pct, usePoll } from '../format';

function Meter({ label, value, max, decimals, hint }: { label: string; value: string; max: string; decimals: number; hint: string }) {
  const p = pct(value, max, decimals);
  const level = p >= 90 ? 'bad' : p >= 60 ? 'warn' : 'ok';
  return (
    <div className="meter">
      <div className="row spread small">
        <span>{label}</span>
        <span className="mono">
          {value} / {max}
        </span>
      </div>
      <div className={`bar ${level}`} role="meter" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <span style={{ width: `${p}%` }} />
      </div>
      <p className="muted small">{hint}</p>
    </div>
  );
}

export default function PortfolioCard({ budget, refreshKey }: { budget: Budget | null; refreshKey: number }) {
  const [portfolio, error, refresh] = usePoll(getPortfolio, 30_000, [refreshKey]);

  return (
    <section className="card">
      <div className="row spread">
        <h2>Portfolio</h2>
        <button className="ghost small" onClick={refresh}>
          Refresh
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!portfolio && !error && <p className="muted">Loading balances…</p>}
      {portfolio && (
        <>
          <p className="total">
            ${portfolio.totalUsd} <span className="muted small">total, testnet value</span>
          </p>
          <ul className="holdings">
            {portfolio.holdings.map((h) => (
              <li key={h.asset}>
                <span className="asset">{h.asset}</span>
                <span className="mono">{h.balance}</span>
                <span className="muted small" title={h.priceSource ? `Price source: ${h.priceSource}` : undefined}>
                  {h.usdValue ? `$${h.usdValue}` : '—'}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {budget && (
        <>
          <h3>Spent today</h3>
          {budget.assets.map((a) => (
            <Meter
              key={a.asset}
              label={a.asset}
              value={a.spentToday}
              max={a.dailyBudget}
              decimals={18}
              hint={`Auto up to ${a.autoMaxPerTx}, needs you up to ${a.hardMaxPerTx}, refused above`}
            />
          ))}
          <Meter
            label="Transactions this hour"
            value={String(budget.txLastHour)}
            max={String(budget.maxTxPerHour)}
            decimals={0}
            hint="Rate limit; over it every request is refused"
          />
        </>
      )}
    </section>
  );
}
