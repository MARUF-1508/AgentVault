import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { decide, getPending } from './api';
import { useAuth } from './auth';
import { useWallet } from './data';

interface ApprovalValue {
  /** The request waiting on the server, as the executor's summary. Null when idle. */
  summary: string | null;
  expiresAt: number | null;
  /** False once the owner minimises the dialog. A new request always re-opens it. */
  open: boolean;
  /** Re-opens a minimised dialog (the topbar pill). */
  show: () => void;
  hide: () => void;
  /** Approve or reject. The server decides; nothing is signed without an owner. */
  answer: (approved: boolean) => Promise<void>;
  busy: boolean;
}

const ApprovalContext = createContext<ApprovalValue | null>(null);

/**
 * Single poller for the server's pending-approval slot, shared by the dialog and
 * the topbar pill. A request opens the dialog by itself; the owner may minimise
 * it to read on, and the pill brings it back. The slot still expires server-side
 * and fails closed, so minimising never leaves a transaction hanging.
 */
export function ApprovalProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const { refresh } = useWallet();
  const [summary, setSummary] = useState<string | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    if (!me) return;
    let alive = true;
    const poll = () =>
      getPending()
        .then((r) => {
          if (!alive) return;
          setSummary(r.pending);
          setExpiresAt(r.expiresAt);
          setId(r.id);
          // Anything we have not seen yet (raised by the agent, or from another
          // tab) pulls the owner straight into the dialog.
          if (r.id && r.id !== seen.current) setOpen(true);
          seen.current = r.id;
        })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [me]);

  // Nudge the owner who has the app in the background. Informational only: the
  // decision itself always needs a click in the dialog.
  const notified = useRef<string | null>(null);
  useEffect(() => {
    if (!summary || notified.current === summary || typeof Notification === 'undefined') return;
    notified.current = summary;
    const amount = /^\s*Amount\s*:\s*(.*)$/m.exec(summary)?.[1] ?? '';
    const target = /0x[0-9a-fA-F]{40}/.exec(summary)?.[0] ?? '';
    const show = () => {
      try {
        new Notification('Agent Vault: approval needed', { body: [amount, target].filter(Boolean).join(' → '), tag: 'av-approval', icon: '/favicon.png' });
      } catch {
        /* some browsers only allow notifications from a service worker */
      }
    };
    if (Notification.permission === 'granted') show();
    else if (Notification.permission === 'default') void Notification.requestPermission().then((p) => p === 'granted' && show());
  }, [summary]);

  const answer = useCallback(
    async (approved: boolean) => {
      if (!id) return;
      setBusy(true);
      try {
        const { decided } = await decide(approved, id);
        setSummary(null);
        setExpiresAt(null);
        setId(null);
        setOpen(false);
        if (!decided) toast.message('That request is no longer waiting (it expired or was answered elsewhere). Nothing was signed.');
        else toast[approved ? 'success' : 'message'](approved ? 'Approved. Signing and broadcasting…' : 'Rejected. Nothing was signed.');
        refresh();
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh, id],
  );

  return (
    <ApprovalContext.Provider value={{ summary, expiresAt, open, show: () => setOpen(true), hide: () => setOpen(false), answer, busy }}>
      {children}
    </ApprovalContext.Provider>
  );
}

export function useApproval(): ApprovalValue {
  const v = useContext(ApprovalContext);
  if (!v) throw new Error('useApproval outside ApprovalProvider');
  return v;
}