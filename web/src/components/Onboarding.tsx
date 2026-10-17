import { motion } from 'framer-motion';
import { CheckCircle2, Circle, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { getActivity, getPortfolio, getVerify } from '../api';
import { useAuth } from '../auth';
import { useWallet } from '../data';
import { usePoll } from '../format';
import ReceiveModal from './ReceiveModal';

const DISMISS_KEY = 'av:onboarding-dismissed';

/** Three concrete steps that get a fresh wallet from zero to a proven transaction. */
export default function Onboarding() {
  const { can } = useAuth();
  const { refreshKey } = useWallet();
  const [portfolio] = usePoll(getPortfolio, 30_000, [refreshKey]);
  const [activity] = usePoll(() => getActivity(50), 15_000, [refreshKey]);
  const [verify, , recheck] = usePoll(getVerify, 20_000, [refreshKey]);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');

  const funded = (portfolio?.holdings.length ?? 0) > 0;
  const transacted = (activity ?? []).some((e) => e.type === 'tx_sent');
  const chainOk = verify?.ok === true;
  const allDone = funded && transacted && chainOk;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  if (dismissed || allDone || !portfolio || !activity || verify === null) return null;

  const steps = [
    {
      done: funded,
      label: 'Fund the testnet wallet',
      hint: can('transact') ? 'Send Base Sepolia ETH to the agent address.' : 'Ask an owner to fund the agent address.',
      action: (
        <button className="ghost small" onClick={() => setReceiveOpen(true)}>
          Receive
        </button>
      ),
    },
    {
      done: transacted,
      label: 'Make a first transfer',
      hint: 'Preview the tier, then send it through the same executor the agent uses.',
      action: can('preview') ? (
        <Link className="btn ghost small" to="/transfer">
          Open Transfer
        </Link>
      ) : null,
    },
    {
      done: chainOk,
      label: 'Verify the audit chain',
      hint: 'Every entry hashes to the previous one; a broken chain means an edit.',
      action: (
        <button
          className="ghost small"
          onClick={() =>
            getVerify()
              .then((r) => (r.ok ? toast.success('Audit chain intact.') : toast.error(`Chain broken at entry ${r.brokenAt}.`)))
              .catch((e: Error) => toast.error(e.message))
              .finally(recheck)
          }
        >
          Check now
        </button>
      ),
    },
  ];
  const done = steps.filter((s) => s.done).length;

  return (
    <motion.section className="card onboarding" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
      <div className="row spread">
        <h2>
          Get started <span className="muted small">· {done}/{steps.length}</span>
        </h2>
        <button className="ghost icon" aria-label="Dismiss checklist" title="Dismiss" onClick={dismiss}>
          <X size={16} />
        </button>
      </div>
      <ol className="checklist">
        {steps.map((s) => (
          <li key={s.label} className={s.done ? 'done' : ''}>
            {s.done ? <CheckCircle2 size={18} className="ok-icon" aria-hidden /> : <Circle size={18} className="muted" aria-hidden />}
            <div>
              <strong>{s.label}</strong>
              <p className="muted small">{s.hint}</p>
            </div>
            <span className="check-action">{s.action}</span>
          </li>
        ))}
      </ol>
      <ReceiveModal open={receiveOpen} onClose={() => setReceiveOpen(false)} />
    </motion.section>
  );
}
