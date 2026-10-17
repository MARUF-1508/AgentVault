import { motion } from 'framer-motion';
import { Eye, EyeOff, KeyRound, Lock, ShieldCheck, User } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { usePageTitle } from '../format';
import { useTheme } from '../theme';

export default function Login() {
  usePageTitle('Sign in');
  const { me, login } = useAuth();
  const { resolved, toggle } = useTheme();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (me) return <Navigate to={from} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    login(username.trim(), password)
      .then(() => navigate(from, { replace: true }))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
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
        <h1>Sign in to Agent Vault</h1>
        <p className="muted">The AI plans. The policy decides. The chain enforces.</p>
        <form onSubmit={submit} className="stack-form">
          <label>
            <span>Username</span>
            <span className="input-icon">
              <User size={16} aria-hidden />
              <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </span>
          </label>
          <label>
            <span>Password</span>
            <span className="input-icon">
              <Lock size={16} aria-hidden />
              <input
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button type="button" className="ghost icon" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((s) => !s)}>
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
          </label>
          {error && (
            <motion.p className="error" initial={{ x: -6 }} animate={{ x: [6, -4, 2, 0] }} transition={{ duration: 0.3 }}>
              {error}
            </motion.p>
          )}
          <button type="submit" className="full" disabled={busy}>
            <KeyRound size={16} aria-hidden /> {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div className="login-foot muted small">
          <ShieldCheck size={14} aria-hidden /> First run? <code>npm run cli -- serve</code> prints the owner password once. Add accounts with{' '}
          <code>npm run cli -- user add &lt;name&gt; &lt;role&gt;</code>.
        </div>
      </motion.div>
    </div>
  );
}
