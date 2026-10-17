import { Monitor, Moon, Sun } from 'lucide-react';
import { useAuth } from '../auth';
import { useWallet } from '../data';
import { CopyButton, usePageTitle } from '../format';
import { useTheme, type ThemeChoice } from '../theme';
import { speak, speechOutputSupported } from '../voice';

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

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
            Accounts are managed from the terminal only, so nobody can grant themselves a role from the browser:
          </p>
          <pre>
            npm run cli -- user add &lt;name&gt; &lt;owner|operator|viewer&gt;{'\n'}npm run cli -- user list{'\n'}npm run cli -- user remove &lt;name&gt;
          </pre>
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
    </>
  );
}
