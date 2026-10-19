import { motion } from 'framer-motion';
import { Eye, EyeOff, KeyRound, Lock, ShieldCheck, User, UserRoundPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { getSetupNeeded, setup, TotpRequiredError } from '../api';
import { useAuth } from '../auth';
import { usePageTitle } from '../format';
import { useTheme } from '../theme';

const USERNAME_RE = /^[a-z0-9_-]{2,32}$/;

export default function Login() {
  usePageTitle('Sign in');
  const { me, login, refresh } = useAuth();
  const { resolved, toggle } = useTheme();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [needed, setNeeded] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSetupNeeded()
      .then((r) => setNeeded(r.needed))
      .catch(() => setNeeded(false));
  }, []);

  if (me) return <Navigate to={from} replace />;

  const clearFields = () => {
    setUsername('');
    setPassword('');
    setConfirm('');
    setCode('');
    setNeedsCode(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const done = (name: string) => {
      clearFields();
      toast.success(needed ? `Owner account created. Welcome, ${name}.` : `Welcome back, ${name}.`);
      // No navigate() here: once the session is in the provider this page
      // renders <Navigate to={from}>, so a second redirect is redundant.
    };
    if (needed) {
      if (!USERNAME_RE.test(username.trim())) return fail('Username: 2-32 of a-z 0-9 _ -.');
      if (password.length < 10) return fail('Password must be at least 10 characters.');
      if (password !== confirm) return fail('Passwords do not match.');
      setup(username.trim(), password)
        // The setup response carries the session cookie; pull it into the
        // provider before navigating, or RequireAuth bounces us back here.
        .then(async (u) => {
          await refresh();
          done(u.user);
        })
        .catch((err: Error) => fail(err.message))
        .finally(() => setBusy(false));
    } else {
      login(username.trim(), password, code.trim() || undefined)
        .then((u) => done(u.user))
        .catch((err: Error) => {
          if (err instanceof TotpRequiredError) setNeedsCode(true);
          fail(err.message);
        })
        .finally(() => setBusy(false));
    }
  };

  const fail = (message: string) => {
    setError(message);
    toast.error(message);
    setBusy(false);
  };

  return (
    <div className="login">
      <div className="login-glow" aria-hidden />
      <button className="ghost small theme-corner" onClick={toggle}>
        {resolved === 'dark' ? 'Light theme' : 'Dark theme'}
      </button>
      <motion.div className="login-card card" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: 'easeOut' }}>
        <div className="brand center">
          <img src="/favicon.png" alt="" width={48} height={48} />
        </div>
        <h1>{needed ? 'Create the owner account' : 'Sign in to Agent Vault'}</h1>
        <p className="muted">{needed ? 'First run: this account will own the wallet UI. Teammates are added later from Settings.' : 'The AI plans. The policy decides. The chain enforces.'}</p>
        <form onSubmit={submit} className="stack-form" autoComplete="off">
          <label>
            <span>Username</span>
            <span className="input-icon">
              <User size={16} aria-hidden />
              <input autoFocus autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </span>
          </label>
          <label>
            <span>Password</span>
            <span className="input-icon">
              <Lock size={16} aria-hidden />
              <input
                type={show ? 'text' : 'password'}
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={needed ? 10 : undefined}
              />
              <button type="button" className="ghost icon" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((s) => !s)}>
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
          </label>
          {needed && (
            <label>
              <span>Confirm password</span>
              <span className="input-icon">
                <Lock size={16} aria-hidden />
                <input type={show ? 'text' : 'password'} autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={10} />
              </span>
            </label>
          )}
          {!needed && needsCode && (
            <label>
              <span>Authenticator code</span>
              <span className="input-icon">
                <ShieldCheck size={16} aria-hidden />
                <input
                  autoFocus
                  className="mono"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123 456"
                  maxLength={7}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </span>
            </label>
          )}
          {error && (
            <motion.p className="error" initial={{ x: -6 }} animate={{ x: [6, -4, 2, 0] }} transition={{ duration: 0.3 }}>
              {error}
            </motion.p>
          )}
          <button type="submit" className="full" disabled={busy}>
            {needed ? <UserRoundPlus size={16} aria-hidden /> : <KeyRound size={16} aria-hidden />} {busy ? 'Working…' : needed ? 'Create owner and sign in' : 'Sign in'}
          </button>
        </form>
        <div className="login-foot muted small">
          <ShieldCheck size={14} aria-hidden />{' '}
          {needed
            ? 'After this, accounts are owner-managed from Settings. The password is stored only as a salted scrypt hash.'
            : 'No self-signup: after the first run, an owner adds accounts from Settings or the CLI (`npm run cli -- user add <name> <role>`).'}
        </div>
      </motion.div>
    </div>
  );
}
