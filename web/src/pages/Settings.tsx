import { BookUser, KeyRound, Monitor, Moon, ShieldCheck, Sun, UserPlus, UserRoundX } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  addContact,
  addDenied,
  addRecipient,
  addUser,
  disableTotp,
  enableTotp,
  generateWallet,
  getTotpStatus,
  getUsers,
  removeContact,
  removeDenied,
  removeRecipient,
  removeUser,
  revokeOtherSessions,
  setupTotp,
  type NewAccount,
  type RecipientLists,
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

/**
 * Owner-only recipient lists. The policy engine reads these on every decision,
 * so editing them is a security-relevant action: adding a known recipient or
 * un-denying one lowers the tier that address gets, which is why the server asks
 * for the password again on those two. The agent has no tool that can reach
 * either list.
 */
function Recipients() {
  const { can, me } = useAuth();
  const { policy, status, refresh: onPolicyChange } = useWallet();
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [hashBefore, setHashBefore] = useState<string | null>(null);

  const allowlist = policy?.recipients.allowlist ?? {};
  const denylist = policy?.recipients.denylist ?? [];

  useEffect(() => {
    setPassword('');
  }, [busy]);

  if (!can('admin')) {
    return (
      <section className="card">
        <h2>Recipients</h2>
        <p className="muted">
          Your role ({me?.role}) cannot change the recipient lists. An owner edits them here, or from the CLI with{' '}
          <code>npm run cli -- recipient</code>.
        </p>
        <ul className="policy-list">
          {Object.entries(allowlist).map(([l, a]) => (
            <li key={l}>
              <span className="team-name">{l}</span>
              <span className="mono muted small addr">{a}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  /** Runs an edit and reports the fingerprint change, which is the audit trail's visible face. */
  const run = (fn: () => Promise<RecipientLists>, message: string) => {
    if (busy) return;
    setBusy(true);
    setHashBefore(status?.policyHash ?? null);
    fn()
      .then((r) => {
        toast.success(message);
        setLabel('');
        setAddress('');
        return onPolicyChange();
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setBusy(false));
  };

  const addKnown = (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !address.trim()) return;
    run(() => addRecipient(label.trim(), address.trim(), password), `${label.trim()} is now a known recipient.`);
  };

  return (
    <section className="card">
      <h2 className="row">
        <ShieldCheck size={18} aria-hidden /> Recipients
      </h2>
      <p className="muted small">
        A known recipient can receive small transfers automatically. Anything not on this list is a T2 that waits for your approval. Every change is written to{' '}
        <code>config/policy.json</code> and to the audit log.
      </p>

      <h3>Known recipients (allowlist)</h3>
      <ul className="policy-list">
        {Object.entries(allowlist).map(([l, a]) => (
          <li key={l}>
            <span className="team-name">{l}</span>
            <span className="mono muted small addr">{a}</span>
            <button
              className="ghost small"
              disabled={busy}
              title={`Stop sending automatically to ${l}`}
              onClick={() => run(() => removeRecipient(l), `${l} removed. Sends to it now need your approval.`)}
            >
              <UserRoundX size={14} aria-hidden /> Remove
            </button>
          </li>
        ))}
        {!Object.keys(allowlist).length && <li className="muted small">(empty — every send needs your approval)</li>}
      </ul>

      <h3>Denied (refused outright, T3)</h3>
      <ul className="policy-list denied">
        {denylist.map((a) => (
          <li key={a}>
            <span className="mono muted small addr">{a}</span>
            <button
              className="ghost small"
              disabled={busy}
              title="Stop refusing this address. It becomes a normal T2 or T1 recipient again."
              onClick={() => run(() => removeDenied(a, password), `${a} is no longer denied.`)}
            >
              Un-deny
            </button>
          </li>
        ))}
        {!denylist.length && <li className="muted small">(empty)</li>}
      </ul>

      <form className="stack-form" onSubmit={addKnown}>
        <h3>Add a known recipient</h3>
        <p className="muted small">
          This lowers the tier for that address, so confirm your password. Use the denylist above for anything you never want to send to.
        </p>
        <div className="row">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label, e.g. bob" aria-label="Label" maxLength={40} required />
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" className="mono" aria-label="Address" required />
        </div>
        <label>
          <span>Your password</span>
          <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Your password" required />
        </label>
        <div className="row">
          <button type="submit" disabled={busy || !label.trim() || !address.trim() || !password}>
            <UserPlus size={15} aria-hidden /> Add known recipient
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy || !address.trim()}
            title="Refuse this address outright. Safe: it never needs your password."
            onClick={() => run(() => addDenied(address.trim()), `${address.trim()} is now denied.`)}
          >
            Deny instead
          </button>
        </div>
      </form>
      {hashBefore && <p className="muted small">Policy fingerprint changed from {hashBefore}. Check it on the Security page.</p>}
    </section>
  );
}

/**
 * Address book (T2): names for addresses you pay now and then. A contact is not
 * trusted: sends to it are still T2 and wait for an owner. The agent can read
 * names to resolve "pay bob", but only an owner can edit the book.
 */
function AddressBook() {
  const { can } = useAuth();
  const { policy, refresh } = useWallet();
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const contacts = policy?.recipients.contacts ?? {};
  const owner = can('admin');

  const run = (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    fn()
      .then(() => {
        toast.success(message);
        setLabel('');
        setAddress('');
        refresh();
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card" aria-labelledby="book-title">
      <h2 className="row" id="book-title">
        <BookUser size={18} aria-hidden /> Address book
      </h2>
      <p className="muted small">
        Names the agent can resolve ("pay bob"). A contact is not trusted: every send to it still needs an owner's approval (T2) unless it is also a known
        recipient above.
      </p>
      <ul className="policy-list">
        {Object.entries(contacts).map(([l, a]) => (
          <li key={l}>
            <span className="team-name">{l}</span>
            <span className="mono muted small addr">{a}</span>
            {owner && (
              <button className="ghost small" disabled={busy} onClick={() => run(() => removeContact(l), `${l} removed from the address book.`)}>
                <UserRoundX size={14} aria-hidden /> Remove
              </button>
            )}
          </li>
        ))}
        {!Object.keys(contacts).length && <li className="muted small">(empty)</li>}
      </ul>
      {owner && (
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim() && address.trim()) run(() => addContact(label.trim(), address.trim()), `${label.trim()} added to the address book.`);
          }}
        >
          <div className="row">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="name, e.g. bob" aria-label="Contact name" maxLength={40} required />
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" className="mono" aria-label="Contact address" required spellCheck={false} />
          </div>
          <div className="row">
            <button type="submit" disabled={busy || !label.trim() || !address.trim()}>
              <UserPlus size={15} aria-hidden /> Add contact
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/**
 * The signing key used to be created only by `npm run keygen`. The owner can do
 * it here too: the server writes the key to the env file (never returns it) and
 * the running process keeps the old key until it restarts.
 */
function AgentWallet() {
  const { can, me } = useAuth();
  const { status } = useWallet();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ address: string; previous: string | null; note: string } | null>(null);

  const generate = (e: FormEvent) => {
    e.preventDefault();
    if (!password || !confirm || busy) return;
    setBusy(true);
    generateWallet(password)
      .then((r) => {
        setResult({ address: r.address, previous: r.previous, note: r.note });
        setPassword('');
        setConfirm(false);
        setOpen(false);
        toast.success('New signing key written to the env file. Restart the server to use it.');
      })
      .catch((err: Error) => toast.error(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card" id="agent-wallet">
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
      {result && (
        <p className="notice small">
          New address <strong className="mono">{result.address}</strong> is in the env file. {result.note} Fund it from a Base Sepolia faucet, then restart the server.
        </p>
      )}
      {can('admin') ? (
        open ? (
          <form className="stack-form" onSubmit={generate}>
            <p className="muted small">
              This replaces the agent key in the env file. The old key is not recoverable from the app: make sure you have a backup path before continuing. The server
              keeps signing with the current key until it restarts.
            </p>
            <label>
              <span>Your password</span>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <label className="check-row">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
              <span>I understand the new key takes effect only after a restart.</span>
            </label>
            <div className="row">
              <button type="submit" className="btn" disabled={busy || !password || !confirm}>
                <KeyRound size={15} aria-hidden /> {busy ? 'Generating…' : 'Generate new wallet'}
              </button>
              <button type="button" className="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="row">
            <button className="ghost" onClick={() => setOpen(true)}>
              <KeyRound size={15} aria-hidden /> {status?.address ? 'Replace the signing key' : 'Generate a wallet'}
            </button>
          </div>
        )
      ) : (
        <p className="muted small">Your role ({me?.role}) cannot rotate the signing key. An owner can do it here or with `npm run keygen`.</p>
      )}
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

        <AgentWallet />
      </div>

      <Reveal>
        <Recipients />
        <AddressBook />
        <Team />
      </Reveal>
    </>
  );
}
