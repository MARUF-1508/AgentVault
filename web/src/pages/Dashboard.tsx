import { motion } from 'framer-motion';
import { Activity, ArrowRight, Bot, Gauge, Link2, Send, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getVerify } from '../api';
import { useAuth } from '../auth';
import AuditTimeline from '../components/AuditTimeline';
import { BudgetMeters, Holdings } from '../components/Portfolio';
import { useWallet } from '../data';
import { pct, usePageTitle, usePoll } from '../format';

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
const rise = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };

function Kpi({ icon, label, value, hint, tone }: { icon: ReactNode; label: string; value: string; hint: string; tone?: 'good' | 'bad' }) {
  return (
    <motion.div variants={rise} className={`card kpi ${tone ?? ''}`}>
      <span className="kpi-icon" aria-hidden>
        {icon}
      </span>
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
      <span className="muted small">{hint}</span>
    </motion.div>
  );
}

export default function Dashboard() {
  usePageTitle('Dashboard');
  const { me, can } = useAuth();
  const { status, budget, refreshKey } = useWallet();
  const [verify] = usePoll(getVerify, 15_000, [refreshKey]);
  const native = budget?.assets[0];

  return (
    <motion.div variants={stagger} initial="hidden" animate="show">
      <motion.div variants={rise} className="page-head">
        <div>
          <h1>Welcome back, {me?.user}</h1>
          <p className="muted">Everything the agent does passes the policy engine first, and every step lands in the audit chain.</p>
        </div>
        <div className="row wrap">
          {can('chat') && (
            <Link className="btn" to="/agent">
              <Bot size={16} aria-hidden /> Ask the agent
            </Link>
          )}
          {can('preview') && (
            <Link className="btn ghost" to="/transfer">
              <Send size={16} aria-hidden /> New transfer
            </Link>
          )}
        </div>
      </motion.div>

      <div className="kpis">
        <Kpi
          icon={<Gauge size={18} />}
          label={`${native?.asset ?? 'ETH'} spent today`}
          value={native ? `${Math.round(pct(native.spentToday, native.dailyBudget))}%` : '…'}
          hint={native ? `${native.spentToday} of ${native.dailyBudget}` : 'Loading'}
        />
        <Kpi
          icon={<Activity size={18} />}
          label="Transactions this hour"
          value={budget ? `${budget.txLastHour} / ${budget.maxTxPerHour}` : '…'}
          hint="Rate limit"
        />
        <Kpi
          icon={<ShieldCheck size={18} />}
          label="Kill switch"
          value={status ? (status.paused ? 'Paused' : 'Active') : '…'}
          hint={status?.paused ? 'Every transaction is refused' : 'Wallet accepts requests'}
          tone={status?.paused ? 'bad' : 'good'}
        />
        <Kpi
          icon={<Link2 size={18} />}
          label="Audit chain"
          value={verify === null ? '…' : verify.ok ? 'Intact' : 'Tampered'}
          hint={verify?.ok === false ? `Broken at entry ${verify.brokenAt}` : 'SHA-256 hash chain'}
          tone={verify === null ? undefined : verify.ok ? 'good' : 'bad'}
        />
      </div>

      <div className="grid-2">
        <motion.div variants={rise}>
          <Holdings />
        </motion.div>
        <motion.section variants={rise} className="card">
          <h2>Spent today</h2>
          <BudgetMeters budget={budget} />
        </motion.section>
      </div>

      <motion.div variants={rise}>
        <AuditTimeline limit={8} compact />
        <Link className="more-link" to="/activity">
          Full audit trail <ArrowRight size={14} aria-hidden />
        </Link>
      </motion.div>
    </motion.div>
  );
}
