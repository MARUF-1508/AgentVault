import { AnimatePresence, motion } from 'framer-motion';
import { Mic, MicOff, RotateCcw, SendHorizontal, ShieldAlert, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { chat } from '../api';
import { useWallet } from '../data';
import { useApproval } from '../approval';
import { linkify, shortAddr } from '../format';
import { findUnlisted, type UnlistedHit } from '../unlisted';
import { speak, speechOutputSupported, useSpeechInput } from '../voice';
import Markdown from './Markdown';

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
  const { status, policy, refresh } = useWallet();
  const { summary } = useApproval();
  const navigate = useNavigate();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<string | undefined>(() => stored('aw-session') ?? undefined);
  const [speakReplies, setSpeakReplies] = useState(() => stored('av-speak') === '1');
  /** Held back until the user chooses: a new recipient in the message. */
  const [offer, setOffer] = useState<{ hit: UnlistedHit; text: string } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  /** Sends a message to the agent. Approval, if any, arrives as its own dialog. */
  const deliver = async (text: string, voice: boolean) => {
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

  /**
   * An address that is not a known recipient means a T2, and the Transfer page
   * shows the tier and reasons without an LLM round trip. Offer that first; the
   * user can still carry on in the chat, where the same policy engine and the
   * same approval apply.
   */
  const send = (raw: string, voice = false) => {
    const text = raw.trim();
    if (!text || busy) return;
    const hit = findUnlisted(text, policy);
    if (hit) {
      setOffer({ hit, text });
      setInput('');
      return;
    }
    void deliver(text, voice);
  };

  const mic = useSpeechInput((text) => void send(text, true));

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
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
        {offer && (
          <div className="offer" role="group" aria-label="New recipient">
            <h3>
              <ShieldAlert size={16} aria-hidden />{' '}
              {offer.hit.denylisted ? 'This address is denied' : 'New recipient'}
            </h3>
            <p className="mono small">{offer.hit.address}</p>
            {offer.hit.denylisted ? (
              <>
                <p className="muted small">
                  It is on the denylist, so the policy refuses it outright (T3). An owner can remove it from Settings → Recipients if that was a mistake.
                </p>
                <div className="row end">
                  <button type="button" className="ghost" onClick={() => { setInput(offer.text); setOffer(null); }}>
                    Back to the message
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="muted small">
                  <strong className="mono">{shortAddr(offer.hit.address)}</strong> is not a known recipient, so this is a <strong>T2</strong>: the agent can
                  submit it, but you have to approve it. The Transfer page shows the tier and the reasons first, with no model involved.
                </p>
                <div className="row end">
                  <button type="button" className="ghost" onClick={() => { setInput(offer.text); setOffer(null); }}>
                    Cancel
                  </button>
                  <button type="button" className="ghost" onClick={() => void deliver(offer.text, false)}>
                    Continue in chat
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const { address, amount, symbol } = offer.hit;
                      const q = new URLSearchParams({ to: address });
                      if (amount) q.set('amount', amount);
                      if (symbol) q.set('asset', symbol);
                      setOffer(null);
                      navigate(`/transfer?${q.toString()}`);
                    }}
                  >
                    Review on Transfer
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {msgs.length === 0 && !offer && (
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
                {m.voice && <Mic size={12} className="voice-tag" aria-label="Spoken" />}{' '}
                {m.from === 'agent' ? <Markdown text={m.text} explorer={status?.explorer ?? null} /> : linkify(m.text, status?.explorer ?? null)}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {busy && (
          <div className="bubble agent" aria-label="Agent is working">
            {summary ? (
              <span className="waiting-approval">
                <ShieldAlert size={14} aria-hidden /> Waiting for an owner to approve one transaction…
              </span>
            ) : (
              <span className="typing">
                <span />
                <span />
                <span />
              </span>
            )}
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
