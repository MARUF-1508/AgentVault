import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useFocusTrap } from '../a11y';
import { resume } from '../api';
import { useWallet } from '../data';

/**
 * Releasing the kill switch re-enables spending, so the server wants the
 * owner's password again. This is the only way to resume from the UI; the
 * kill switch itself stays out of reach of the model.
 */
export default function ResumeWallet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh } = useWallet();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, open, onClose);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    resume(password)
      .then(() => {
        toast.success('Wallet resumed. Transactions can be signed again.');
        setPassword('');
        onClose();
        refresh();
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="resume-title">
          <motion.section
            ref={ref}
            className="card resume-card"
            initial={{ opacity: 0, scale: 0.95, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row spread">
              <h2 id="resume-title">Resume the wallet</h2>
              <button className="ghost icon" aria-label="Close" onClick={onClose}>
                <X size={18} aria-hidden />
              </button>
            </div>
            <p className="muted small">
              The kill switch refused every transaction. Resuming re-enables signing, so confirm your password. The action is written to the audit log.
            </p>
            <form className="stack-form" onSubmit={submit}>
              <label>
                <span>Your password</span>
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
              </label>
              {error && (
                <p className="notice" role="alert" style={{ color: 'var(--bad)' }}>
                  {error}
                </p>
              )}
              <div className="row end">
                <button type="button" className="ghost" onClick={onClose}>
                  Cancel
                </button>
                <button className="btn" disabled={busy || !password}>
                  {busy ? 'Resuming…' : 'Resume and allow signing'}
                </button>
              </div>
            </form>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
