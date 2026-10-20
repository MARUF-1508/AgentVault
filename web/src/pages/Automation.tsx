import { CalendarClock, Loader2, Play } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getSchedules, runSchedules, type ScheduleRule, type SchedulesView, type ScheduleRun } from '../api';
import { useAuth } from '../auth';
import { useWallet } from '../data';
import { linkify, usePageTitle } from '../format';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function triggerText(rule: ScheduleRule): string {
  const t = rule.trigger;
  return t.kind === 'weekly'
    ? `Every ${DAYS[t.weekday]} at ${t.atTimeUtc} UTC`
    : `When ${t.asset} is ${t.dropPct}% below $${t.baselineUsd}`;
}

function actionText(rule: ScheduleRule): string {
  const a = rule.action;
  const amount = a.amount ?? `${a.amountPct}% of the balance`;
  if (a.kind === 'swap') return `Swap ${amount} ${a.tokenIn ?? ''} → ${a.tokenOut ?? ''}`;
  const unit = a.kind === 'native_transfer' ? ' ETH' : ` ${a.token ?? ''}`;
  return `Send ${amount}${unit} to ${a.to ?? ''}`;
}

/**
 * Scheduled and conditional rules used to be visible only through
 * `npm run cli -- schedule`. The runner is shared, so a due rule fired here
 * still goes through the same Executor, policy engine and approval flow.
 */
export default function Automation() {
  usePageTitle('Automation');
  const { can } = useAuth();
  const { status, refresh } = useWallet();
  const [data, setData] = useState<SchedulesView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [results, setResults] = useState<ScheduleRun[] | null>(null);

  const load = useCallback(() => {
    getSchedules()
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const run = () => {
    setBusy(true);
    runSchedules(dryRun)
      .then((r) => {
        setResults(r.results);
        toast.success(r.ran === 0 ? 'No rule is due right now.' : `${dryRun ? 'Previewed' : 'Ran'} ${r.ran} due rule(s).`);
        load();
        if (!dryRun) refresh();
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setBusy(false));
  };

  const scheduler = data?.scheduler ?? status?.scheduler ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Automation</h1>
          <p className="muted">
            Scheduled and conditional rules. Each run is a normal intent: the policy engine can still refuse it and a T2 rule waits for an owner.
          </p>
        </div>
      </div>

      <section className="card">
        <h2 className="row">
          <CalendarClock size={18} aria-hidden /> Background runner
        </h2>
        {scheduler ? (
          <p className="muted small">
            {scheduler.enabled
              ? `On: checks every ${scheduler.intervalSec}s. Last run ${scheduler.lastRunAt ? new Date(scheduler.lastRunAt).toLocaleString() : 'not yet'}.`
              : 'Off (`SCHEDULER=false`). Run due rules below, or start the server with SCHEDULER=true.'}
            {scheduler.lastError ? ` Last error: ${scheduler.lastError}` : ''}
          </p>
        ) : (
          <p className="muted small">The runner status is unavailable. Rules still run when you press the button below.</p>
        )}
        <div className="row">
          <button className="btn" onClick={run} disabled={busy || !can('transact')}>
            {busy ? <Loader2 size={15} className="spin" aria-hidden /> : <Play size={15} aria-hidden />} Run due rules
          </button>
          <label className="row check-row">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            <span>Dry run (policy-check only, sends nothing)</span>
          </label>
        </div>
        {!can('transact') && <p className="muted small">Your role can view the rules but not run them.</p>}
        {results && (
          <div className="run-results" role="status">
            <h3>Last run</h3>
            {results.length === 0 ? (
              <p className="muted small">No rule was due.</p>
            ) : (
              <ul>
                {results.map((r) => (
                  <li key={r.ruleId}>
                    <strong>{r.ruleId}</strong> — {r.status}
                    {r.error ? `: ${r.error}` : ''}
                    {r.txHash ? <> · {linkify(r.txHash, status?.explorer ?? null)}</> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Rules</h2>
        {error && (
          <p className="notice" role="alert" style={{ color: 'var(--bad)' }}>
            {error}
          </p>
        )}
        {!data && !error && <p className="muted">Loading rules…</p>}
        {data && data.rules.length === 0 && (
          <p className="muted">
            No rules yet. Add them to <code>config/schedules.json</code>; the format is in the README.
          </p>
        )}
        {data && data.rules.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Trigger</th>
                  <th>Action</th>
                  <th>Enabled</th>
                  <th>Last run</th>
                </tr>
              </thead>
              <tbody>
                {data.rules.map((r) => {
                  const last = data.lastRuns.find((x) => x.ruleId === r.id);
                  return (
                    <tr key={r.id}>
                      <td className="mono">{r.id}</td>
                      <td>{triggerText(r)}</td>
                      <td>{actionText(r)}</td>
                      <td>{r.enabled ? 'yes' : 'no'}</td>
                      <td className="small">
                        {last ? (
                          <>
                            {last.status ?? 'ran'} · {new Date(last.ts).toLocaleString()}
                          </>
                        ) : (
                          <span className="muted">never</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          Rules are configuration, never something the model writes. The background runner only starts when the server runs with <code>SCHEDULER=true</code>.
        </p>
      </section>
    </>
  );
}
