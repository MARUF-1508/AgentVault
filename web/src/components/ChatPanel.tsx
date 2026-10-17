import { AnimatePresence, motion } from 'framer-motion';
import { Mic, MicOff, RotateCcw, SendHorizontal, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { chat } from '../api';
import { useWallet } from '../data';
import { linkify } from '../format';
import { speak, speechOutputSupported, useSpeechInput } from '../voice';

interface Msg {
  from: 'you' | 'agent' | 'error';
  text: string;
  events?: string[];
  voice?: boolean;
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

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage is a convenience only */
  }
}

export default function ChatPanel() {
  const { status, refresh } = useWallet();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<string | undefined>(() => stored('aw-session') ?? undefined);
  const [speakReplies, setSpeakReplies] = useState(() => stored('av-speak') === '1');
  const logRef = useRef<HTMLDivElement>(null);

  const send = async (raw: string, voice = false) => {
    const text = raw.trim();
    if (!text || busy) return;
    setInput('');
    setMsgs((m) => [...m, { from: 'you', text, voice }]);
    setBusy(true);
    try {
      const r = await chat(text, session);
      setSession(r.session);
      store('aw-session', r.session);
      setMsgs((m) => [...m, { from: 'agent', text: r.answer, events: r.events }]);
      if (speakReplies || voice) speak(r.answer);
    } catch (err) {
      setMsgs((m) => [...m, { from: 'error', text: (err as Error).message }]);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const mic = useSpeechInput((text) => void send(text, true));

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  const newChat = () => {
    setMsgs([]);
    setSession(undefined);
    store('aw-session', null);
  };

  const toggleSpeak = () => {
    setSpeakReplies((v) => {
      store('av-speak', v ? null : '1');
      if (v) window.speechSynthesis?.cancel();
      return !v;
    });
  };

  const noModel = status !== null && !status.llm;

  return (
    <section className="card chat">
      <div className="row spread">
        <h2>Talk to the agent</h2>
        <div className="row">
          {speechOutputSupported() && (
            <button className={`ghost icon ${speakReplies ? 'on' : ''}`} onClick={toggleSpeak} aria-pressed={speakReplies} title={speakReplies ? 'Stop reading replies aloud' : 'Read replies aloud'}>
              {speakReplies ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </button>
          )}
          {msgs.length > 0 && (
            <button className="ghost icon" onClick={newChat} title="New chat" aria-label="New chat">
              <RotateCcw size={16} />
            </button>
          )}
        </div>
      </div>
      {noModel && (
        <p className="notice">
          Chat needs <code>LLM_API_KEY</code> in <code>.env</code>. You can still test every tier on the Transfer page.
        </p>
      )}
      <div className="chat-log" ref={logRef} aria-live="polite">
        {msgs.length === 0 && (
          <div className="empty">
            <p className="muted">
              Ask in plain language, or tap the microphone and speak. Small sends to known recipients go through on their own, bigger or new ones wait for an
              owner's approval, and anything over the limits is refused with a reason.
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
        <AnimatePresence initial={false}>
          {msgs.map((m, i) => (
            <motion.div
              key={i}
              className={`bubble ${m.from}`}
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.2 }}
            >
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
              <div className="text">
                {m.voice && <Mic size={12} className="voice-tag" aria-label="Spoken" />} {linkify(m.text, status?.explorer ?? null)}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
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
      {mic.listening && (
        <div className="listening" role="status">
          <span className="pulse" aria-hidden /> Listening… {mic.interim && <em>“{mic.interim}”</em>}
        </div>
      )}
      {mic.error && <p className="error">{mic.error}</p>}
      <form className="row composer" onSubmit={onSubmit}>
        {mic.supported && (
          <button
            type="button"
            className={`icon mic ${mic.listening ? 'live' : 'ghost'}`}
            onClick={mic.listening ? mic.stop : mic.start}
            disabled={busy || noModel}
            aria-pressed={mic.listening}
            aria-label={mic.listening ? 'Stop listening' : 'Speak to the agent'}
            title={mic.listening ? 'Stop listening' : 'Speak to the agent'}
          >
            {mic.listening ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
        )}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='e.g. "send 0.0002 ETH to alice"'
          aria-label="Message to the agent"
          disabled={noModel}
        />
        <button type="submit" className="icon" disabled={busy || noModel || !input.trim()} aria-label="Send">
          <SendHorizontal size={18} />
        </button>
      </form>
    </section>
  );
}
