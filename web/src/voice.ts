import { useCallback, useEffect, useRef, useState } from 'react';

/* Minimal typings for the Web Speech API, which TypeScript's DOM lib omits. */
interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}

function recognitionCtor(): (new () => Recognition) | undefined {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/**
 * Push-to-talk speech input using the browser's own recogniser (free, no
 * server). `onFinal` receives the final transcript. Voice can only type into
 * the chat; it can never approve a transaction.
 */
export function useSpeechInput(onFinal: (text: string) => void, lang = 'en-US') {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const rec = useRef<Recognition | null>(null);
  const finalCb = useRef(onFinal);
  finalCb.current = onFinal;
  const supported = Boolean(recognitionCtor());

  const stop = useCallback(() => rec.current?.stop(), []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = false;
    let final = '';
    r.onresult = (e) => {
      let partial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) final += res[0].transcript;
        else partial += res[0].transcript;
      }
      setInterim(final + partial);
    };
    r.onerror = (e) => setError(e.error === 'not-allowed' ? 'Microphone permission was denied.' : `Voice error: ${e.error}`);
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim('');
      if (final.trim()) finalCb.current(final.trim());
    };
    setError('');
    rec.current = r;
    setListening(true);
    r.start();
  }, [lang]);

  useEffect(() => () => rec.current?.stop(), []);

  return { supported, listening, interim, error, start, stop };
}

/** Text-to-speech for agent replies. Links and hashes are read as short words. */
export function speak(text: string): void {
  if (!('speechSynthesis' in window)) return;
  const clean = text
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/0x[0-9a-fA-F]{40,64}/g, (h) => `address ending ${h.slice(-4).split('').join(' ')}`)
    .replace(/[*_`#>]/g, '');
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(clean));
}

export const speechOutputSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;
