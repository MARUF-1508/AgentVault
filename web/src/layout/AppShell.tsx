import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, LogOut, Menu, Moon, OctagonPause, Search, ShieldAlert, Sun, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useOutlet } from 'react-router-dom';
import { toast } from 'sonner';
import { pause } from '../api';
import { ApprovalProvider, useApproval } from '../approval';
import { useAuth } from '../auth';
import ApprovalModal from '../components/ApprovalModal';
import CommandPalette from '../components/CommandPalette';
import OfflineBanner from '../components/OfflineBanner';
import { useWallet } from '../data';
import { shortAddr } from '../format';
import { NAV } from '../nav';
import { useTheme } from '../theme';

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="sidenav" aria-label="Main">
      {NAV.map(({ to, label, icon: Icon }) => (
        <NavLink key={to} to={to} end={to === '/'} onClick={onNavigate} className={({ isActive }) => `navlink ${isActive ? 'active' : ''}`}>
          {({ isActive }) => (
            <>
              {isActive && <motion.span layoutId="nav-active" className="nav-active" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              <Icon size={18} aria-hidden />
              <span>{label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="brand">
      <img src="/favicon.png" alt="" width={32} height={32} />
      <div>
        <strong>Agent Vault</strong>
        <span className="muted small">Policy-guarded AI wallet</span>
      </div>
    </div>
  );
}

function UserMenu() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (!me) return null;
  return (
    <div className="menu" ref={ref}>
      <button className="ghost user-chip" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden>
          {me.user.slice(0, 1).toUpperCase()}
        </span>
        <span className="hide-sm">{me.user}</span>
        <span className={`role role-${me.role}`}>{me.role}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            className="menu-pop"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
          >
            <p className="muted small">
              Signed in as <strong>{me.user}</strong>
            </p>
            <p className="muted small">Can: {me.permissions.join(', ')}</p>
            <button role="menuitem" className="ghost full" onClick={() => void logout()}>
              <LogOut size={16} aria-hidden /> Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PauseControl() {
  const { can } = useAuth();
  const { status, refresh } = useWallet();
  const [confirming, setConfirming] = useState(false);
  if (!status || !can('pause')) return null;
  if (status.paused) {
    return (
      <span className="pill pill-bad" title="Resume from the CLI: npm run cli -- resume">
        <span className="dot bad" /> Paused
      </span>
    );
  }
  if (confirming) {
    return (
      <span className="pill pill-bad confirm-pill">
        <span className="hide-sm">Refuse everything?</span>
        <button
          className="danger small"
          onClick={() =>
            pause()
              .then(() => {
                toast.success('Wallet paused. Every transaction is now refused.');
                setConfirming(false);
                refresh();
              })
              .catch((e: Error) => toast.error(e.message))
          }
        >
          Pause
        </button>
        <button className="ghost small" onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button className="danger" onClick={() => setConfirming(true)} title="Kill switch. Resuming is CLI-only.">
      <OctagonPause size={16} aria-hidden /> <span className="hide-sm">Pause wallet</span>
    </button>
  );
}

/**
 * Manual route into a waiting T2. The dialog opens by itself when a request
 * arrives; this is for the owner who minimised it or was on another tab.
 */
function ApprovalPill() {
  const { summary, open, show } = useApproval();
  const { can } = useAuth();
  if (!summary || !can('approve')) return null;
  return (
    <button className={`pill pill-warn approval-pill ${open ? '' : 'pulsing'}`} onClick={show} title="A transaction is waiting for your approval">
      <ShieldAlert size={15} aria-hidden />
      <span className="hide-sm">Approval needed</span>
      <span className="sr-only">Open the pending approval</span>
    </button>
  );
}

function Shell() {
  const { resolved, toggle } = useTheme();
  const { status } = useWallet();
  const location = useLocation();
  const outlet = useOutlet();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);

  useEffect(() => setDrawer(false), [location.pathname]);

  // ⌘K / Ctrl-K opens the command palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <SideNav />
        <div className="sidebar-foot muted small">
          {status && (
            <>
              <span className="dot ok" /> {status.chain}
              {status.address && <span className="mono"> · {shortAddr(status.address)}</span>}
            </>
          )}
        </div>
      </aside>

      <AnimatePresence>
        {drawer && (
          <>
            <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDrawer(false)} />
            <motion.aside
              className="drawer"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 400, damping: 40 }}
              aria-label="Menu"
            >
              <div className="row spread">
                <Brand />
                <button className="ghost icon" aria-label="Close menu" onClick={() => setDrawer(false)}>
                  <X size={18} />
                </button>
              </div>
              <SideNav onNavigate={() => setDrawer(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="content">
        <header className="topbar">
          <button className="ghost icon only-sm" aria-label="Open menu" onClick={() => setDrawer(true)}>
            <Menu size={20} />
          </button>
          <div className="pills hide-sm">
            {status && (
              <>
                <span className={`pill ${status.vault ? 'pill-good' : ''}`} title={status.vault ?? 'Native transfers are signed by the agent key'}>
                  {status.vault ? 'Vault mode' : 'Direct mode'}
                </span>
                <span className="pill">{status.llm ? status.model : 'No model'}</span>
              </>
            )}
          </div>
          <div className="row topbar-actions">
            <ApprovalPill />
            <button className="ghost palette-btn" aria-label="Search and commands (Ctrl+K)" title="Search and commands (Ctrl+K)" onClick={() => setPalette(true)}>
              <Search size={15} aria-hidden />
              <span className="hide-sm">Search</span>
              <kbd className="palette-kbd hide-sm">⌘K</kbd>
            </button>
            <PauseControl />
            <button className="ghost icon" onClick={toggle} aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`} title="Toggle theme">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={resolved}
                  initial={{ rotate: -90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  exit={{ rotate: 90, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  style={{ display: 'inline-flex' }}
                >
                  {resolved === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                </motion.span>
              </AnimatePresence>
            </button>
            <UserMenu />
          </div>
        </header>

        <OfflineBanner />

        {status?.paused && (
          <p className="banner bad">
            The kill switch is on, so every transaction is refused. Run <code>npm run cli -- resume</code> to turn it off.
          </p>
        )}

        <AnimatePresence mode="wait">
          <motion.main
            key={location.pathname}
            className="page"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            {outlet}
          </motion.main>
        </AnimatePresence>
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ApprovalModal />
    </div>
  );
}

/** The pending-approval slot is shared by the dialog and the topbar pill. */
export default function AppShell() {
  return (
    <ApprovalProvider>
      <Shell />
    </ApprovalProvider>
  );
}
