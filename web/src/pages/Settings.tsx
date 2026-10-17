import { Monitor, Moon, Sun, UserPlus, UserRoundX } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { addUser, getUsers, removeUser, type NewAccount, type Role, type UserAccount } from '../api';
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
