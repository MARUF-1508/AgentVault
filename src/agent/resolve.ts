import type { Policy } from '../policy/types.js';

export interface RecipientResolution {
  query: string;
  found: boolean;
  /** Present when found: the address to use. */
  address?: string;
  source?: 'allowlist' | 'contacts' | 'denylist' | 'address';
  /** The saved label the query matched, when it matched one. */
  label?: string;
  allowlisted?: boolean;
  denylisted?: boolean;
  /** Labels already saved, so the model can offer them when nothing matches. */
  knownLabels: string[];
  /** Close but not exact matches. Never used automatically; the user must confirm. */
  didYouMean?: string[];
  /** Plain-language next step for the model. */
  guidance: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Lower-case, and drop a leading "@" and surrounding punctuation: "@Alice." -> "alice". */
function normalise(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Levenshtein distance, capped (we only care about 0..2). */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Resolves a user-named recipient against the saved allowlist, then the address
 * book (contacts), then the denylist. Pure. The model must call this before any
 * transfer and must ask the user for an address when nothing matches — it never
 * gets to guess one. Near misses come back as `didYouMean` for the user to
 * confirm; they are never resolved silently, because "alcie" quietly becoming
 * "alice" is exactly the kind of guess that sends money to the wrong place.
 */
export function resolveRecipient(policy: Policy, raw: string): RecipientResolution {
  const query = raw.trim();
  const lower = query.toLowerCase();
  const { allowlist, denylist } = policy.recipients;
  const contacts = policy.recipients.contacts ?? {};
  const knownLabels = [...Object.keys(allowlist), ...Object.keys(contacts)];
  const isDenied = (addr: string) => denylist.some((a) => a.toLowerCase() === addr.toLowerCase());

  if (ADDRESS_RE.test(query)) {
    const denylisted = isDenied(query);
    const entry = Object.entries(allowlist).find(([, a]) => a.toLowerCase() === lower);
    const contact = Object.entries(contacts).find(([, a]) => a.toLowerCase() === lower);
    return {
      query,
      found: true,
      address: query,
      source: 'address',
      ...(entry ? { label: entry[0] } : contact ? { label: contact[0] } : {}),
      allowlisted: Boolean(entry) && !denylisted,
      denylisted,
      knownLabels,
      guidance: denylisted
        ? 'This address is on the denylist. Do not send; the policy will refuse it (T3).'
        : entry
          ? `Already saved in the allowlist as "${entry[0]}". Proceed with preview_transaction.`
          : contact
            ? `Saved in the address book as "${contact[0]}" (not allowlisted): a transfer needs a human approval (T2).`
            : 'Not on any saved list: it proceeds as a new recipient and needs a human approval (T2).',
    };
  }

  const wanted = normalise(query);
  const match = Object.entries(allowlist).find(([label]) => normalise(label) === wanted);
  if (match) {
    return {
      query,
      found: true,
      address: match[1],
      source: 'allowlist',
      label: match[0],
      allowlisted: true,
      denylisted: false,
      knownLabels,
      guidance: `Allowlisted as "${match[0]}". Proceed with preview_transaction using this address.`,
    };
  }

  const contact = Object.entries(contacts).find(([label]) => normalise(label) === wanted);
  if (contact) {
    const denylisted = isDenied(contact[1]);
    return {
      query,
      found: true,
      address: contact[1],
      source: 'contacts',
      label: contact[0],
      allowlisted: false,
      denylisted,
      knownLabels,
      guidance: denylisted
        ? `"${contact[0]}" is in the address book but its address is denylisted. Do not send (T3).`
        : `Found "${contact[0]}" in the address book. It is not allowlisted, so a transfer needs a human approval (T2). Proceed with preview_transaction using this address.`,
    };
  }

  const didYouMean = wanted
    ? knownLabels.filter((l) => {
        const n = normalise(l);
        return n !== wanted && (distance(n, wanted) <= (wanted.length > 4 ? 2 : 1) || (wanted.length >= 3 && n.startsWith(wanted)));
      })
    : [];

  return {
    query,
    found: false,
    knownLabels,
    ...(didYouMean.length ? { didYouMean } : {}),
    guidance: didYouMean.length
      ? `No saved recipient called "${query}". Did the user mean ${didYouMean.map((d) => `"${d}"`).join(' or ')}? Ask them to confirm; do NOT pick one yourself.`
      : `No saved recipient called "${query}". Do NOT invent or guess an address. Ask the user for the 0x address, mentioning the names already saved (${knownLabels.join(', ') || 'none'}).`,
  };
}
