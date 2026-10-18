/**
 * Recognises a recipient address the user typed into the Agent page that is not
 * on the allowlist, so the UI can offer the Transfer page instead of spending an
 * LLM round trip on it.
 *
 * Deliberately self-contained (no imports) so the root test suite can import it
 * under `moduleResolution: NodeNext` and test it without a DOM. The allowlist
 * shape is declared locally rather than imported from `Policy`.
 */
export interface RecipientPolicy {
  recipients: { allowlist: Record<string, string>; denylist: string[] };
}

export interface UnlistedHit {
  address: string;
  /** On the denylist: the policy refuses it outright (T3). */
  denylisted: boolean;
  /** Amount parsed from the same sentence, for prefilling the Transfer form. */
  amount?: string;
  /** Symbol parsed alongside the amount, e.g. "ETH". */
  symbol?: string;
}

const ADDRESS = /0x[0-9a-fA-F]{40}/g;
/** Require send-ish wording so a pasted router or spender is not read as a recipient. */
const SEND = /\b(send|transfer|pay|withdraw|forward)\b/i;
/** Whitespace between the number and the symbol keeps it from matching inside a 0x hash. */
const AMOUNT = /\b(\d+(?:\.\d+)?)\s+([A-Za-z]{2,10})\b/;

/**
 * Returns the first address in `text` that is not a known recipient, or null when
 * there is nothing worth interrupting the user for. An address that *is* on the
 * allowlist never produces a hit: that path needs no human gate beyond the tier
 * the engine already assigns it.
 */
export function findUnlisted(text: string, policy: RecipientPolicy | null | undefined): UnlistedHit | null {
  if (!policy || !SEND.test(text)) return null;
  const found = text.match(ADDRESS);
  if (!found) return null;

  const allow = Object.values(policy.recipients.allowlist).map((a) => a.toLowerCase());
  const deny = policy.recipients.denylist.map((a) => a.toLowerCase());

  for (const raw of found) {
    const address = raw.toLowerCase();
    if (allow.includes(address)) continue;
    const amount = text.match(AMOUNT);
    return {
      address: raw,
      denylisted: deny.includes(address),
      ...(amount ? { amount: amount[1], symbol: amount[2].toUpperCase() } : {}),
    };
  }
  return null;
}