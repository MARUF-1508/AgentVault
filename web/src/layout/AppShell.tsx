import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, LogOut, Menu, Moon, OctagonPause, RefreshCw, Search, ShieldAlert, Sun, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../a11y';
import { NavLink, useLocation, useOutlet } from 'react-router-dom';
import { toast } from 'sonner';
import { pause } from '../api';
import { ApprovalProvider, useApproval } from '../approval';
import { useAuth } from '../auth';
import ApprovalModal from '../components/ApprovalModal';
import CommandPalette from '../components/CommandPalette';
import ResumeWallet from '../components/ResumeWallet';
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
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // Keyboard: Escape closes and returns focus to the trigger; opening moves focus
  // to the first item; focus leaving the menu closes it (WCAG 2.1.1, 2.4.3).
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!me) return null;
  return (
    <div
      className="menu"
      ref={ref}
      onBlur={(e) => {
        if (open && !ref.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        className="ghost user-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="avatar" aria-hidden>
          {me.user.slice(0, 1).toUpperCase()}
        </span>
        <span className="sr-only">Account menu: </span>
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
            <p className="muted small">
              <kbd>Ctrl</kbd>+<kbd>K</kbd> search · <kbd>Esc</kbd> close
            </p>
            <button role="menuitem" className="ghost full" onClick={() => void logout()}>
              <LogOut size={16} aria-hidden /> Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PauseControl({ onResume }: { onResume: () => void }) {
  const { can } = useAuth();
  const { status, refresh } = useWallet();
  const [confirming, setConfirming] = useState(false);
  if (!status || !can('pause')) return null;
  if (status.paused) {
    return (
      <button className="pill pill-bad" onClick={onResume} disabled={!can('admin')} title={can('admin') ? 'Resume signing (owner password required)' : 'Ask an owner to resume the wallet'}>
        <span className="dot bad" /> Paused
      </button>
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
    <button className="danger" onClick={() => setConfirming(true)} title="Kill switch. Only an owner can resume, with the password again.">
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

/**
 * MetaMask-style network indicator: which chain, and whether its RPC answers.
 * Clicking it re-checks immediately. Degraded means read data may be stale;
 * the policy engine still refuses anything it cannot price or simulate.
 */
function NetworkIndicator({ compact = false }: { compact?: boolean }) {
  const { status, health, healthError, refresh } = useWallet();
  const ok = health?.rpc.ok ?? false;
  const label = health ? (ok ? 'Connected' : 'RPC unreachable') : healthError ? 'Server unreachable' : 'Checking…';
  const chain = health?.chain ?? status?.chain ?? 'Network';
  const detail = health?.rpc.ok
    ? `Block ${health.rpc.blockNumber} · ${health.rpc.latencyMs} ms`
    : (health?.rpc.error ?? healthError ?? 'Checking the chain connection');
  return (
    <button
      type="button"
      className={`net ${ok ? 'net-ok' : health || healthError ? 'net-bad' : ''} ${compact ? 'net-compact' : ''}`}
      onClick={refresh}
      title={`${detail}. Click to re-check.`}
    >
      {/* The accessible name starts with the visible text (WCAG 2.5.3); the rest is screen-reader only. */}
      <span className={`dot ${ok ? 'ok' : health || healthError ? 'bad' : ''}`} aria-hidden />
      <span>{chain}</span>
      {!compact && <span className="muted small hide-sm">{ok ? `#${health!.rpc.blockNumber}` : label}</span>}
      <span className="sr-only">
        {compact || ok ? `, ${label}` : ''}. {detail}. Re-check the connection.
      </span>
    </button>
  );
}

/** Shown when the chain RPC is down: says what still works and offers a retry. */
function RpcBanner() {
  const { health, refresh } = useWallet();
  if (!health || health.rpc.ok) return null;
  return (
    <div className="banner warn" role="status">
      <span>
        Can't reach the {health.chain} RPC. Balances may be stale. Sending is refused until the chain answers again; nothing is queued.
      </span>
      <button className="ghost small" onClick={refresh}>
        <RefreshCw size={14} aria-hidden /> Retry
      </button>
    </div>
  );
}

function Shell() {
  const { resolved, toggle } = useTheme();
  const { can } = useAuth();
  const { status } = useWallet();
  const location = useLocation();
  const outlet = useOutlet();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const firstRoute = useRef(true);
  useFocusTrap(drawerRef, drawer, () => setDrawer(false));

  useEffect(() => setDrawer(false), [location.pathname]);

  // After client-side navigation, move focus to the new page so keyboard and
  // screen-reader users start at its content instead of the old link (2.4.3).
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    const t = setTimeout(() => mainRef.current?.focus({ preventScroll: false }), 60);
    return () => clearTimeout(t);
  }, [location.pathname]);

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
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      {/* One polite live region for status messages announced from anywhere (4.1.3). */}
      <div id="av-live" className="sr-only" role="status" aria-live="polite" aria-atomic="true" />
      <aside className="sidebar" aria-label="Sidebar">
        <Brand />
        <SideNav />
        <div className="sidebar-foot muted small">
          <NetworkIndicator compact />
          {status?.address && <span className="mono">{shortAddr(status.address)}</span>}
        </div>
      </aside>

      <AnimatePresence>
        {drawer && (
          <>
            <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDrawer(false)} aria-hidden />
            <motion.aside
              ref={drawerRef}
              className="drawer"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 400, damping: 40 }}
              role="dialog"
              aria-modal="true"
              aria-label="Menu"
            >
              <div className="row spread">
                <Brand />
                <button className="ghost icon" aria-label="Close menu" onClick={() => setDrawer(false)}>
                  <X size={18} aria-hidden />
                </button>
              </div>
              <SideNav onNavigate={() => setDrawer(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="content">
        <header className="topbar">
          <button className="ghost icon only-sm" aria-label="Open menu" aria-expanded={drawer} onClick={() => setDrawer(true)}>
            <Menu size={20} aria-hidden />
          </button>
          <NetworkIndicator />
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
            <button className="ghost palette-btn" title="Search and commands (Ctrl+K)" onClick={() => setPalette(true)}>
              <Search size={15} aria-hidden />
              <span className="hide-sm">Search</span>
              <span className="sr-only"> and commands, Control K</span>
              <kbd className="palette-kbd hide-sm" aria-hidden>
                ⌘K
              </kbd>
            </button>
            <PauseControl onResume={() => setResumeOpen(true)} />
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
                  {resolved === 'dark' ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
                </motion.span>
              </AnimatePresence>
            </button>
            <UserMenu />
          </div>
        </header>

        <OfflineBanner />
        <RpcBanner />

        {status?.paused && (
          <p className="banner bad">
            The kill switch is on, so every transaction is refused.{' '}
            {can('admin') ? (
              <button className="link-btn" onClick={() => setResumeOpen(true)}>
                Resume signing
              </button>
            ) : (
              'Ask an owner to resume it from their account.'
            )}
          </p>
        )}

        {/* Enter-only page transition. An exit animation (AnimatePresence
            mode="wait") could get stuck when the route changed while the
            current page was still animating in, leaving the old page on
            screen after the URL had changed. */}
        <motion.main
          key={location.pathname}
          ref={mainRef}
          id="main"
          tabIndex={-1}
          className="page"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          {outlet}
        </motion.main>
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ResumeWallet open={resumeOpen} onClose={() => setResumeOpen(false)} />
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
