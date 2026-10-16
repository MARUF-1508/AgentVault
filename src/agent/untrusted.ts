/**
 * Prompt-injection defence. Any text that comes from outside the program —
 * token names, memos, revert reasons, web content, even our own tool results
 * (which can echo on-chain strings) — is untrusted data, never instructions.
 *
 * We delimit it inside an `<untrusted>` envelope and strip anything that could
 * forge the envelope, so hostile text cannot "break out" and impersonate a
 * system message.
 */

export const UNTRUSTED_TAG = 'untrusted';

/** Matches an opening or closing `<untrusted>` tag, tolerant of whitespace/case. */
const FORGED_TAG = /<\s*\/?\s*untrusted\s*>/gi;

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? String(value);
}

/** Wrap a value as delimited untrusted data, neutralising any forged envelope tags. */
export function wrapUntrusted(value: unknown): string {
  const safe = serialize(value).replace(FORGED_TAG, '[removed-forged-tag]');
  return `<${UNTRUSTED_TAG}>${safe}</${UNTRUSTED_TAG}>`;
}
