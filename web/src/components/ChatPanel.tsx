import { useCallback, useEffect, useState } from 'react';
import { chat } from '../api';

interface Msg {
  from: 'you' | 'agent';
  text: string;
}

export default function ChatPanel() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<string | undefined>(() => localStorage.getItem('aw-session') ?? undefined);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMsgs((m) => [...m, { from: 'you', text }]);
    setBusy(true);
    try {
      const r = await chat(text, session);
      setSession(r.session);
      localStorage.setItem('aw-session', r.session);
      setMsgs((m) => [...m, { from: 'agent', text: r.answer }]);
    } catch (err) {
      setMsgs((m) => [...m, { from: 'agent', text: `error: ${(err as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }, [input, busy, session]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && document.activeElement?.id === 'chat-input') void send();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [send]);

  return (
    <section className="card">
      <h2>Chat</h2>
      <div className="chat-log">
        {msgs.length === 0 && <p className="muted">Ask for balances or request a transfer. T2 transactions pause here for approval.</p>}
        {msgs.map((m, i) => (
          <p key={i} className={m.from === 'you' ? 'you' : 'agent'}>
            <strong>{m.from === 'you' ? 'you ›' : 'agent ›'}</strong> {m.text}
          </p>
        ))}
        {busy && <p className="muted">working…</p>}
      </div>
      <div className="row">
        <input
          id="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='e.g. "send 0.0002 ETH to alice"'
        />
        <button onClick={() => void send()} disabled={busy}>Send</button>
      </div>
    </section>
  );
}
