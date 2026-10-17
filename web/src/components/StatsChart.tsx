import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getStats } from '../api';
import { useWallet } from '../data';
import { usePoll } from '../format';

const tooltipStyle = {
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  fontSize: 12,
  color: 'var(--text)',
} as const;

/** Last 14 UTC days of on-chain activity, rebuilt from the audit log. */
export default function StatsChart() {
  const { refreshKey } = useWallet();
  const [stats] = usePoll(getStats, 30_000, [refreshKey]);
  const total = stats?.reduce((n, d) => n + d.txCount, 0) ?? 0;
  const empty = stats !== null && total === 0;

  return (
    <section className="card">
      <div className="row spread wrap">
        <h2>On-chain activity</h2>
        <div className="legend small muted">
          <span className="legend-item">
            <i className="swatch accent" /> Broadcasts
          </span>
          <span className="legend-item">
            <i className="swatch bad" /> Refused by policy
          </span>
        </div>
      </div>
      {stats === null ? (
        <div className="skeleton" style={{ height: 190, marginTop: '0.75rem' }} />
      ) : (
        <>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={190}>
              <AreaChart data={stats} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="av-tx" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} width={38} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelFormatter={(label) => `UTC day ${String(label)}`}
                  formatter={(value, name) => [String(value ?? 0), name === 'txCount' ? 'broadcasts' : 'refused']}
                />
                <Area type="monotone" dataKey="txCount" stroke="var(--accent-2)" strokeWidth={2} fill="url(#av-tx)" />
                <Area type="monotone" dataKey="deniedCount" stroke="var(--bad)" strokeWidth={1.5} strokeDasharray="4 3" fill="transparent" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {empty && <p className="muted small">No on-chain activity in the last 14 days. Broadcasts and refusals show up here the day they happen.</p>}
        </>
      )}
    </section>
  );
}
