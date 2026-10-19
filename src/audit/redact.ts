/**
 * Secret redaction (S8). Applied to everything the audit log stores and to error
 * text the web server returns, so a private key, API key or password can never
 * land in a log file, a CSV export or an HTTP response, even if a library error
 * message happens to echo one.
 *
 * Two layers: field names that are secret by nature, and the exact secret values
 * this process was configured with (registered at start-up by `loadEnv`).
 */
export const REDACTED = '[redacted]';

const SECRET_KEY = /(private.?key|secret|password|passphrase|mnemonic|seed.?phrase|api.?key|authorization|cookie|session.?token)/i;
/** Common API-key shapes (OpenAI-style `sk-…`, bearer tokens) and PEM blocks. */
const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{16,}/g, /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g];

const known = new Set<string>();

/** Remember a configured secret so any later occurrence is scrubbed. Short values are ignored. */
export function registerSecret(value: string | undefined): void {
  if (!value || value.length < 12) return;
  known.add(value);
  if (value.startsWith('0x')) known.add(value.slice(2));
}

/** Test hook: forget registered secrets. */
export function clearSecrets(): void {
  known.clear();
}

export function redactText(text: string): string {
  let out = text;
  for (const secret of known) {
    // Case-insensitive: a hex key may be echoed upper- or mixed-case.
    if (out.toLowerCase().includes(secret.toLowerCase())) {
      out = out.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), REDACTED);
    }
  }
  for (const re of SECRET_SHAPES) out = out.replace(re, REDACTED);
  return out;
}

/** Deep copy with secret fields and secret values replaced. */
export function redact<T>(value: T): T {
  return walk(value, undefined) as T;
}

function walk(value: unknown, key: string | undefined): unknown {
  if (key !== undefined && SECRET_KEY.test(key) && value !== null && value !== undefined && value !== '') return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, undefined));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, k)]));
  }
  return value;
}
