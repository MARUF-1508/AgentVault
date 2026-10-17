import type { Policy } from '../policy/types.js';

export interface RecipientResolution {
  query: string;
  found: boolean;
  /** Present when found: the address to use. */
  address?: string;
  source?: 'allowlist' | 'denylist' | 'address';
  allowlisted?: boolean;
  denylisted?: boolean;
  /** Labels already saved, so the model can offer them when nothing matches. */
  knownLabels: string[];
  /** Plain-language next step for the model. */
  guidance: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Resolves a user-named recipient against the saved allowlist and denylist.
 * Pure. The model must call this before any transfer and must ask the user for
 * an address when nothing matches — it never gets to guess one.
 */
export function resolveRecipient(policy: Policy, raw: string): RecipientResolution {
  const query = raw.trim();
  const lower = query.toLowerCase();
  const knownLabels = Object.keys(policy.recipients.allowlist);

  if (ADDRESS_RE.test(query)) {
    const denylisted = policy.recipients.denylist.some((a) => a.toLowerCase() === lower);
    const entry = Object.entries(policy.recipients.allowlist).find(([, a]) => a.toLowerCase() === lower);
    return {
      query,
      found: true,
      address: query,
      source: 'address',
      allowlisted: Boolean(entry) && !denylisted,
      denylisted,
      knownLabels,
      guidance: denylisted
        ? 'This address is on the denylist. Do not send; the policy will refuse it (T3).'
        : entry
          ? `Already saved in the allowlist as "${entry[0]}". Proceed with preview_transaction.`
          : 'Not on any saved list: it proceeds as a new recipient and needs a human approval (T2).',
    };
  }

  const match = Object.entries(policy.recipients.allowlist).find(([label]) => label.toLowerCase() === lower);
  if (match) {
    return {
      query,
      found: true,
      address: match[1],
      source: 'allowlist',
      allowlisted: true,
      denylisted: false,
      knownLabels,
      guidance: `Allowlisted as "${match[0]}". Proceed with preview_transaction using this address.`,
    };
  }

  return {
    query,
    found: false,
    knownLabels,
    guidance: `No saved recipient called "${query}". Do NOT invent or guess an address. Ask the user for the 0x address, mentioning the names already saved (${knownLabels.join(', ') || 'none'}).`,
  };
}
