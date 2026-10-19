import { useFocusTrap } from '../a11y';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Copy, LogOut, Moon, Search, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { getVerify } from '../api';
import { useAuth } from '../auth';
import { useWallet } from '../data';
import { NAV } from '../nav';
import { useTheme } from '../theme';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords: string;
  run: () => void;
}

/** ⌘K / Ctrl-K palette: jump between pages and run common actions. */
export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { me, can, logout } = useAuth();
  const { status, refresh } = useWallet();
  const { resolved, toggle } = useTheme();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const commands = useMemo<Command[]>(() => {
    const pages: Command[] = NAV.map(({ to, label, icon }) => ({
      id: `go:${to}`,
      label: `Go to ${label}`,
      hint: 'page',
      icon,
      keywords: `navigate open ${label}`,
      run: () => navigate(to),
    }));
    const actions: Command[] = [
      {
        id: 'theme',
        label: `Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`,
        hint: 'appearance',
        icon: Moon,
        keywords: 'theme dark light appearance mode',
        run: toggle,
      },
      {
        id: 'verify',
        label: 'Verify the audit chain',
        hint: 'security',
        icon: ShieldCheck,
        keywords: 'audit hash chain tamper verify integrity check',
        run: () => {
          getVerify()
            .then((r) => (r.ok ? toast.success('Audit chain intact. Every entry hashes to the previous one.') : toast.error(`Chain broken at entry ${r.brokenAt}.`)))
            .catch((e: Error) => toast.error(e.message));
        },
      },
    ];
    if (status?.address) {
      actions.push({
        id: 'copy-address',
        label: 'Copy wallet address',
        hint: status.address.slice(0, 10) + '…',
        icon: Copy,
        keywords: 'copy address clipboard wallet',
        run: () =>
          navigator.clipboard
            .writeText(status.address!)
            .then(() => toast.success('Wallet address copied.'))
            .catch(() => toast.error('Could not access the clipboard.')),
      });
    }
    if (can('transact') || can('preview')) {
      actions.push({
        id: 'refresh',
        label: 'Refresh wallet data',
        hint: 'status, budget, balances',
        icon: CheckCircle2,
        keywords: 'refresh reload update balances budget',
        run: () => {
          refresh();
          toast.success('Refreshing wallet data.');
        },
      });
    }
    actions.push({
      id: 'signout',
      label: 'Sign out',
      hint: me?.user,
      icon: LogOut,
      keywords: 'sign out logout exit leave',
      run: () => void logout(),
    });
    return [...pages, ...actions];
  }, [navigate, resolved, toggle, status, can, me, logout, refresh]);

  const q = query.trim().toLowerCase();
  const shown = q ? commands.filter((c) => `${c.label} ${c.hint ?? ''} ${c.keywords}`.toLowerCase().includes(q)) : commands;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    // Focus after the entrance animation starts, or Safari drops it. Cancelled
    // if the palette closes first: a late focus() on the closing input would
    // steal focus back from the opener and then drop it on <body>.
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => setActive(0), [q]);
  // Arrow keys move the highlight while focus stays in the search field, so
  // keep the active option in view as it moves beyond the list's max-height.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  // Tab stays inside the palette and focus returns to the opener on close.
  useFocusTrap(dialogRef, open, onClose);

  const run = (c: Command) => {
    onClose();
    c.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') return onClose();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && shown[active]) {
      e.preventDefault();
      run(shown[active]);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="overlay palette-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.section
            ref={dialogRef}
            className="card palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={{ opacity: 0, y: -14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="input-icon">
              <Search size={16} aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search pages and actions…"
                aria-label="Search pages and actions"
                role="combobox"
                aria-expanded="true"
                aria-autocomplete="list"
                aria-controls={shown.length ? 'palette-list' : undefined}
                aria-activedescendant={shown[active] ? `palette-opt-${active}` : undefined}
                autoComplete="off"
              />
              <kbd className="palette-kbd">esc</kbd>
            </div>
            {shown.length === 0 ? (
              <p className="muted small palette-empty">Nothing matches “{query}”.</p>
            ) : (
              <ul ref={listRef} id="palette-list" className="palette-list" role="listbox" aria-label="Commands">
                {shown.map((c, i) => (
                  <li key={c.id}>
                    <button
                      id={`palette-opt-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className={`palette-item ${i === active ? 'on' : ''}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => run(c)}
                    >
                      <c.icon size={16} aria-hidden />
                      <span className="palette-label">{c.label}</span>
                      {c.hint && <span className="muted small palette-hint">{c.hint}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
