import { QrCode, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import CountUp from 'react-countup';
import { Link } from 'react-router-dom';
import { getPortfolio, type Budget } from '../api';
import { useWallet } from '../data';
import { pct, usePoll } from '../format';
import AssetIcon from './AssetIcon';
import ReceiveModal from './ReceiveModal';

export function Meter({ label, value, max, decimals = 18, hint }: { label: string; value: string; max: string; decimals?: number; hint?: string }) {
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
      {hint && <p className="muted small">{hint}</p>}
    </div>
  );
}

export function BudgetMeters({ budget }: { budget: Budget | null }) {
  if (!budget)
    return (
      <>
        <div className="skeleton" style={{ height: 44, marginBottom: '0.7rem' }} />
        <div className="skeleton" style={{ height: 44 }} />
      </>
    );
  return (
    <>
      {budget.assets.map((a) => (
        <Meter key={a.asset} label={a.asset} value={a.spentToday} max={a.dailyBudget} hint={`Auto up to ${a.autoMaxPerTx}, needs you up to ${a.hardMaxPerTx}, refused above`} />
      ))}
      <Meter label="Transactions this hour" value={String(budget.txLastHour)} max={String(budget.maxTxPerHour)} decimals={0} hint="Rate limit; over it every request is refused" />
    </>
  );
}

export function Holdings() {
  const { refreshKey, status } = useWallet();
  const [portfolio, error, refresh] = usePoll(getPortfolio, 30_000, [refreshKey]);
  const [receiveOpen, setReceiveOpen] = useState(false);
  return (
    <section className="card">
      <div className="row spread">
        <h2>Holdings</h2>
        <div className="row">
          {status?.address && (
            <button className="ghost icon" onClick={() => setReceiveOpen(true)} aria-label="Show receive address and QR code" title="Receive">
              <QrCode size={16} />
            </button>
          )}
          <button className="ghost icon" onClick={refresh} aria-label="Refresh balances" title="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!portfolio && !error && <div className="skeleton" style={{ height: 120 }} />}
      {portfolio && (
        <>
          <p className="total">
            <CountUp end={Number(portfolio.totalUsd) || 0} prefix="$" decimals={2} separator="," duration={1.1} preserveValue />{' '}
            <span className="muted small">total, testnet value</span>
          </p>
          {portfolio.holdings.length === 0 ? (
            <div className="empty-state">
              <p className="muted">No balances yet. Fund the wallet on Base Sepolia to see holdings here.</p>
              <div className="row wrap">
                {status?.address && (
                  <button className="ghost small" onClick={() => setReceiveOpen(true)}>
                    Show receive address
                  </button>
                )}
                <a className="btn ghost small" href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" rel="noreferrer">
                  Get testnet ETH
                </a>
                <Link className="btn ghost small" to="/agent">
                  Ask the agent
                </Link>
              </div>
            </div>
          ) : (
            <ul className="holdings">
              {portfolio.holdings.map((h) => (
                <li key={h.asset}>
                  <AssetIcon asset={h.asset} />
                  <span className="asset">{h.asset}</span>
                  <span className="mono">{h.balance}</span>
                  <span className="muted small" title={h.priceSource ? `Price source: ${h.priceSource}` : undefined}>
                    {h.usdValue ? `$${h.usdValue}` : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <ReceiveModal open={receiveOpen} onClose={() => setReceiveOpen(false)} />
    </section>
  );
}
