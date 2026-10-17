import { KeyRound, Monitor, Moon, ShieldCheck, Sun, UserPlus, UserRoundX } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  addUser,
  disableTotp,
  enableTotp,
  getTotpStatus,
  getUsers,
  removeUser,
  revokeOtherSessions,
  setupTotp,
  type NewAccount,
  type Role,
  type UserAccount,
} from '../api';
import { useAuth } from '../auth';
import Reveal from '../components/Reveal';
import { useWallet } from '../data';
import { CopyButton, usePageTitle } from '../format';
import { useTheme, type ThemeChoice } from '../theme';
import { speak, speechOutputSupported } from '../voice';

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

const ROLES: { value: Role; hint: string }[] = [
  { value: 'viewer', hint: 'read-only' },
  { value: 'operator', hint: 'can preview, send, chat' },
  { value: 'owner', hint: 'can also approve and pause' },
];

/** Owner-only account management. The server enforces the role on every call. */
function Team() {
  const { can, me } = useAuth();
  const [state, setState] = useState<{ users: UserAccount[]; you: string } | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<NewAccount | null>(null);

  const load = useCallback(() => getUsers().then(setState).catch((e: Error) => toast.error(e.message)), []);

  useEffect(() => {
    if (can('admin')) void load();
  }, [can, load]);

  if (!can('admin')) {
    return (
      <section className="card">
        <h2>Team</h2>
        <p className="muted">
          Your role ({me?.role}) cannot manage accounts. An owner (or the CLI, <code>npm run cli -- user add</code>) adds teammates and grants roles.
        </p>
      </section>
    );
  }

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    addUser(name.trim(), role)
      .then((acc) => {
        setFresh(acc);
        setName('');
        toast.success(`${acc.username} added as ${acc.role}.`);
        return load();
      })
      .catch((err: Error) => toast.error(err.message))
      .finally(() => setBusy(false));
  };

  const remove = (username: string) => {
    removeUser(username)
      .then(() => {
        toast.success(`${username} removed. Their sessions were signed out.`);
        return load();
      })
      .catch((err: Error) => toast.error(err.message));
  };

  return (
    <section className="card">
      <h2>Team</h2>
      <p className="muted small">Accounts live in a git-ignored file; passwords are stored as salted scrypt hashes and shown exactly once when created.</p>
      {fresh && (
        <div className="fresh-pass">
          <p>
            Password for <strong>{fresh.username}</strong> — copy it now, it is not shown again:
          </p>
          <p className="row">
            <code className="mono">{fresh.password}</code>
            <CopyButton value={fresh.password} label="Copy password" />
            <button className="ghost small" onClick={() => setFresh(null)}>
              Done
            </button>
          </p>
        </div>
      )}
      <ul className="team">
        {(state?.users ?? []).map((u) => (
          <li key={u.username}>
            <span className="avatar" aria-hidden>
              {u.username.slice(0, 1).toUpperCase()}
            </span>
            <span className="team-name">
              {u.username}
              {u.username === state?.you && <span className="muted small"> (you)</span>}
            </span>
            <span className={`role role-${u.role}`}>{u.role}</span>
            <button
              className="ghost small"
              disabled={u.username === state?.you}
              title={u.username === state?.you ? 'You cannot remove your own account' : `Remove ${u.username}`}
              onClick={() => remove(u.username)}
            >
              <UserRoundX size={14} aria-hidden /> Remove
            </button>
          </li>
        ))}
      </ul>
      <form className="row team-add" onSubmit={add}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="username (a-z 0-9 _ -)"
          aria-label="New username"
          pattern="[a-z0-9_-]{2,32}"
          title="2-32 characters: a-z 0-9 _ -"
          required
        />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.value} — {r.hint}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy || !name.trim()}>
          <UserPlus size={15} aria-hidden /> Add
        </button>
      </form>
    </section>
  );
}

/**
 * Two-factor sign-in and session control for the signed-in account itself.
 * The secret stays pending server-side until one valid code confirms it, so a
 * half-finished setup can never lock anyone out.
 */
function Security() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getTotpStatus()
      .then((r) => setEnabled(r.enabled))
      .catch(() => setEnabled(null));
  }, []);

  const begin = () => {
    setBusy(true);
    setupTotp()
      .then(setSetup)
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setBusy(false));
  };

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    enableTotp(code)
      .then(() => {
        setEnabled(true);
        setSetup(null);
        setCode('');
        toast.success('Two-factor sign-in is on.');
      })
      .catch((err: Error) => toast.error(err.message))
      .finally(() => setBusy(false));
  };

  const disable = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    disableTotp(password)
      .then(() => {
        setEnabled(false);
        setPassword('');
        toast.success('Two-factor sign-in is off.');
      })
      .catch((err: Error) => toast.error(err.message))
      .finally(() => setBusy(false));
  };

  const revoke = () => {
    revokeOtherSessions()
      .then((r) => toast.success(r.revoked === 0 ? 'No other devices were signed in.' : `Signed out ${r.revoked} other session(s).`))
      .catch((e: Error) => toast.error(e.message));
  };

  return (
    <section className="card">
      <h2 className="row">
        <ShieldCheck size={18} aria-hidden /> Sign-in security
      </h2>
      {enabled === null && <p className="muted">Checking…</p>}
      {enabled === false && !setup && (
        <>
          <p className="muted small">
            Two-factor is off. Turn it on to require a 6-digit code from an authenticator app every time this account signs in.
          </p>
          <button onClick={begin} disabled={busy}>
            <KeyRound size={15} aria-hidden /> Turn on two-factor
          </button>
        </>
      )}
      {enabled === false && setup && (
        <form className="stack-form" onSubmit={confirm}>
          <p className="muted small">Scan this with any authenticator app, then type the 6-digit code it shows to confirm.</p>
          <div className="row totp-setup">
            <span className="totp-qr">
              <QRCodeSVG value={setup.uri} size={148} />
            </span>
            <div>
              <p className="muted small">Cannot scan? Enter the key by hand:</p>
              <p className="row">
                <code className="mono">{setup.secret}</code>
                <CopyButton value={setup.secret} label="Copy 2FA key" />
              </p>
            </div>
          </div>
          <label>
            <span>Code from the app</span>
            <input
              className="mono"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </label>
          <div className="row">
            <button type="submit" disabled={busy || code.trim().length < 6}>
              Confirm and turn on
            </button>
            <button type="button" className="ghost" onClick={() => setSetup(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {enabled === true && (
        <form className="stack-form" onSubmit={disable}>
          <p className="muted small">Two-factor is on. To turn it off, confirm your password.</p>
          <label>
            <span>Password</span>
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <button type="submit" className="ghost" disabled={busy || !password}>
            Turn off two-factor
          </button>
        </form>
      )}
      <p className="muted small sessions-line">
        Sessions expire after 30 minutes without activity (8 hours at most).{' '}
        <button type="button" className="ghost small" onClick={revoke}>
          Sign out my other devices
        </button>
      </p>
    </section>
  );
}

export default function Settings() {
  usePageTitle('Settings');
  const { choice, setChoice } = useTheme();
  const { me } = useAuth();
  const { status } = useWallet();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Preferences are saved in this browser only.</p>
        </div>
      </div>
      <div className="grid-2">
        <section className="card">
          <h2>Appearance</h2>
          <div className="theme-picker" role="radiogroup" aria-label="Theme">
            {THEMES.map(({ value, label, icon: Icon }) => (
              <button key={value} role="radio" aria-checked={choice === value} className={`theme-option ${choice === value ? 'on' : ''}`} onClick={() => setChoice(value)}>
                <Icon size={18} aria-hidden /> {label}
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>Voice</h2>
          {speechOutputSupported() ? (
            <>
              <p className="muted small">Use the microphone and speaker buttons on the Agent page. Recognition and speech run in your browser.</p>
              <button className="ghost" onClick={() => speak('Agent Vault voice is working. Approvals still need a click.')}>
                Test the voice
              </button>
            </>
          ) : (
            <p className="muted">This browser has no speech support. Try Chrome or Edge.</p>
          )}
        </section>

        <section className="card">
          <h2>Account</h2>
          <dl className="fields">
            <dt>User</dt>
            <dd>{me?.user}</dd>
            <dt>Role</dt>
            <dd>
              <span className={`role role-${me?.role}`}>{me?.role}</span>
            </dd>
            <dt>Can</dt>
            <dd>{me?.permissions.join(', ')}</dd>
          </dl>
          <p className="muted small">
            Want another account? Ask an owner, or run <code>npm run cli -- user add &lt;name&gt; &lt;role&gt;</code> on the host.
          </p>
        </section>

        <Security />

        <section className="card">
          <h2>Wallet</h2>
          <dl className="fields">
            <dt>Chain</dt>
            <dd>
              {status?.chain} ({status?.chainId})
            </dd>
            <dt>Address</dt>
            <dd className="mono">
              {status?.address ?? 'read-only (no key)'} {status?.address && <CopyButton value={status.address} />}
            </dd>
            <dt>Mode</dt>
            <dd>{status?.vault ? 'Vault (on-chain caps)' : 'Direct (EOA)'}</dd>
            <dt>Model</dt>
            <dd>{status?.model ?? 'not configured'}</dd>
          </dl>
        </section>
      </div>

      <Reveal>
        <Team />
      </Reveal>
    </>
  );
}
