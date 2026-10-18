import { useEffect, useState, type ReactNode } from 'react';
import type { Tier } from './api';

export const TIER_LABEL: Record<Tier, string> = {
  T1_AUTO: 'T1 · auto',
  T2_CONFIRM: 'T2 · needs you',
  T3_DENY: 'T3 · refused',
};

export function TierBadge({ tier }: { tier: string }) {
  const known = tier in TIER_LABEL;
  return <span className={`tier tier-${tier.slice(0, 2).toLowerCase()}`}>{known ? TIER_LABEL[tier as Tier] : tier}</span>;
}

export const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/**
 * Display-only: shorten a decimal string to at most 8 significant digits so a
 * wallet balance does not read as 0.094954698377520177. String arithmetic, so
 * the value itself never passes through a JS number; the caller keeps the full
 * value in a title attribute.
 */
export function shortAmount(value: string): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!m) return value;
  const whole = m[1].replace(/^0+/, '') || '0';
  const frac = m[2] ?? '';
  const keep = 8 - (whole === '0' ? 0 : whole.length);
  if (keep <= 0) return m[1].replace(/^0+/, '') || '0';
  const trimmed = frac.slice(0, keep).replace(/0+$/, '');
  return trimmed ? `${m[1]}.${trimmed}` : m[1];
}

/** Engine reasons arrive joined by spaces; split them back into sentences. */
export const splitReasons = (why: string) => why.split(/(?<=[.!])\s+(?=[A-Z0-9])/).filter(Boolean);

/**
 * Ratio of two decimal strings as a percentage (0 to 100), computed in bigint so
 * token amounts never pass through a JS number. Only the final percentage does.
 */
export function pct(part: string, whole: string, decimals = 18): number {
  const scale = (s: string) => {
    const [i = '0', f = ''] = s.split('.');
    return BigInt(i + f.padEnd(decimals, '0').slice(0, decimals));
  };
  try {
    const w = scale(whole);
    if (w === 0n) return 0;
    const p = (scale(part) * 10_000n) / w;
    return Math.min(Number(p) / 100, 100);
  } catch {
    return 0;
  }
}

/** Turns URLs and 0x hashes/addresses in agent text into explorer links. */
export function linkify(text: string, explorer: string | null): ReactNode[] {
  const parts = text.split(/(https?:\/\/[^\s)]+|0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40})/g);
  return parts.map((p, i) => {
    if (/^https?:\/\//.test(p)) {
      return (
        <a key={i} href={p} target="_blank" rel="noreferrer">
          {p.length > 48 ? `${p.slice(0, 45)}…` : p}
        </a>
      );
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(p) && explorer) {
      return (
        <a key={i} className="mono" href={`${explorer}/tx/${p}`} target="_blank" rel="noreferrer">
          {shortAddr(p)}
        </a>
      );
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(p) && explorer) {
      return (
        <a key={i} className="mono" href={`${explorer}/address/${p}`} target="_blank" rel="noreferrer">
          {shortAddr(p)}
        </a>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

/** Sets the tab title, e.g. "Activity · Agent Vault". */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Agent Vault` : 'Agent Vault';
  }, [title]);
}

/** Polls `fn` every `ms` while mounted; `deps` changes trigger an immediate refresh. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []): [T | null, string, () => void] {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = () =>
      fn()
        .then((v) => {
          if (!alive) return;
          setValue(v);
          setError('');
        })
        .catch((e: Error) => alive && setError(e.message));
    run();
    const t = setInterval(run, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, tick, ...deps]);
  return [value, error, () => setTick((n) => n + 1)];
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ghost small"
      onClick={() =>
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          })
          .catch(() => {})
      }
    >
      {done ? 'Copied' : label}
    </button>
  );
}
