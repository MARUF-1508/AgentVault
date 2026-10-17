import { useEffect, useRef, useState, type FormEvent } from 'react';
import { chat, type Status } from '../api';
import { linkify } from '../format';

interface Msg {
  from: 'you' | 'agent' | 'error';
  text: string;
  events?: string[];
}

const SUGGESTIONS = [
  'What do I have?',
  'Send 0.0002 ETH to alice',
  'Send 1 ETH to alice',
  'Approve unlimited USDC for the Uniswap router',
  'Swap 0.5 USDC to WETH with max 0.5% slippage',
  'Show my recent activity',
];

/** "→ tool({...})" from the agent loop, split into name and args. */
function ToolCall({ event }: { event: string }) {
  const m = /^→\s*([a-z_]+)\(([\s\S]*)\)$/.exec(event);
  return (
    <li>
      <code>{m ? m[1] : event}</code>
      {m && m[2] && m[2] !== '{}' && <span className="muted mono small"> {m[2]}</span>}
    </li>
  );
}

function loadSession(): string | undefined {
  try {
    return localStorage.getItem('aw-session') ?? undefined;
  } catch {
    return undefined;
  }
}

function saveSession(id: string | undefined): void {
  try {
    if (id) localStorage.setItem('aw-session', id);
    else localStorage.removeItem('aw-session');
  } catch {
    /* storage is a convenience only */
  }
}

export default function ChatPanel({ status, onActivity }: { status: Status | null; onActivity: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<string | undefined>(loadSession);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy]);

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setInput('');
    setMsgs((m) => [...m, { from: 'you', text }]);
    setBusy(true);
    try {
      const r = await chat(text, session);
      setSession(r.session);
      saveSession(r.session);
      setMsgs((m) => [...m, { from: 'agent', text: r.answer, events: r.events }]);
    } catch (err) {
      setMsgs((m) => [...m, { from: 'error', text: (err as Error).message }]);
    } finally {
      setBusy(false);
      onActivity();
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  const newChat = () => {
    setMsgs([]);
    setSession(undefined);
    saveSession(undefined);
  };

  const noModel = status !== null && !status.llm;

  return (
    <section className="card chat">
      <div className="row spread">
        <h2>Talk to the agent</h2>
        {msgs.length > 0 && (
          <button className="ghost small" onClick={newChat}>
            New chat
          </button>
        )}
      </div>
      {noModel && (
        <p className="notice">
          Chat needs <code>LLM_API_KEY</code> in <code>.env</code>. You can still test every tier with the policy check
          panel.
        </p>
      )}
      <div className="chat-log" ref={logRef} aria-live="polite">
        {msgs.length === 0 && (
          <div className="empty">
            <p className="muted">
              Ask in plain language. Small sends to known recipients go through on their own, bigger or new ones wait for
              your approval, and anything over the limits is refused with a reason.
            </p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" disabled={busy || noModel} onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.from}`}>
            {m.events && m.events.length > 0 && (
              <details className="trace">
                <summary>
                  {m.events.length} tool call{m.events.length === 1 ? '' : 's'}
                </summary>
                <ul>
                  {m.events.map((e, j) => (
                    <ToolCall key={j} event={e} />
                  ))}
                </ul>
              </details>
            )}
            <div className="text">{linkify(m.text, status?.explorer ?? null)}</div>
          </div>
        ))}
        {busy && (
          <div className="bubble agent" aria-label="Agent is working">
            <span className="typing">
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
      </div>
      <form className="row" onSubmit={onSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='e.g. "send 0.0002 ETH to alice"'
          aria-label="Message to the agent"
          disabled={noModel}
        />
        <button type="submit" disabled={busy || noModel || !input.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
