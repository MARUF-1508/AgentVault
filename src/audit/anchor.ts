import type { Hex } from 'viem';

/**
 * On-chain audit anchors (S2). An anchor is a zero-value transaction from the
 * agent wallet to itself whose calldata is
 *
 *   "AVAUDIT1" (8 bytes) | seq (uint64, big-endian) | head hash (32 bytes)
 *
 * Anyone with the tx hash can read it back from the chain and check that the
 * local log still contains entry #seq with exactly that hash. Editing, truncating
 * or rewriting history before an anchor is then detectable even if the attacker
 * also recomputes the local hash chain, because the chain cannot be rewritten.
 */
const MAGIC = '4156415544495431'; // "AVAUDIT1"

export function encodeAnchor(seq: number, headHash: string): Hex {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('anchor seq must be a non-negative integer');
  if (!/^[0-9a-f]{64}$/.test(headHash)) throw new Error('anchor head hash must be 64 lowercase hex chars');
  return `0x${MAGIC}${seq.toString(16).padStart(16, '0')}${headHash}`;
}

export interface AnchorCheck {
  txHash: string;
  ok: boolean;
  seq?: number;
  reason: string;
}

/**
 * Checks every anchor against the chain (`audit verify --onchain`). For each
 * anchor tx: the calldata must decode, the tx must come from and go to the
 * agent wallet, and the local log must still hold entry #seq with exactly the
 * anchored hash. Because the local chain links every entry to the one before, a
 * matching anchor proves the whole log up to #seq is the one that was anchored.
 *
 * `txHashes` defaults to the anchors recorded in the log itself; pass hashes
 * explicitly to check a log that may have been rewritten or deleted.
 */
export async function verifyAnchors(
  entries: { seq: number; type: string; hash: string; data: Record<string, unknown> }[],
  getTx: (hash: Hex) => Promise<{ input: Hex; from: string; to: string | null } | null>,
  opts: { wallet?: string; txHashes?: string[] } = {},
): Promise<{ ok: boolean; checks: AnchorCheck[] }> {
  const hashes =
    opts.txHashes ?? entries.filter((e) => e.type === 'anchor' && typeof e.data.txHash === 'string').map((e) => String(e.data.txHash));
  const checks: AnchorCheck[] = [];
  for (const txHash of [...new Set(hashes)]) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      checks.push({ txHash, ok: false, reason: 'not a transaction hash' });
      continue;
    }
    let tx;
    try {
      tx = await getTx(txHash as Hex);
    } catch (err) {
      checks.push({ txHash, ok: false, reason: `could not read the transaction: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!tx) {
      checks.push({ txHash, ok: false, reason: 'transaction not found on this chain' });
      continue;
    }
    const anchor = decodeAnchor(tx.input);
    if (!anchor) {
      checks.push({ txHash, ok: false, reason: 'transaction is not an audit anchor' });
      continue;
    }
    if (opts.wallet && (tx.from.toLowerCase() !== opts.wallet.toLowerCase() || tx.to?.toLowerCase() !== opts.wallet.toLowerCase())) {
      checks.push({ txHash, ok: false, seq: anchor.seq, reason: 'anchor was not sent by this wallet to itself' });
      continue;
    }
    const entry = entries[anchor.seq];
    if (!entry || entry.seq !== anchor.seq) {
      checks.push({ txHash, ok: false, seq: anchor.seq, reason: `local log has no entry #${anchor.seq} (truncated or deleted)` });
      continue;
    }
    if (entry.hash !== anchor.headHash) {
      checks.push({ txHash, ok: false, seq: anchor.seq, reason: `entry #${anchor.seq} differs from the anchored hash (history rewritten)` });
      continue;
    }
    checks.push({ txHash, ok: true, seq: anchor.seq, reason: `entry #${anchor.seq} matches the on-chain anchor` });
  }
  return { ok: checks.length > 0 && checks.every((c) => c.ok), checks };
}

/** Parses anchor calldata; null for anything that is not an anchor. */
export function decodeAnchor(data: string | undefined): { seq: number; headHash: string } | null {
  if (!data) return null;
  const hex = data.toLowerCase().replace(/^0x/, '');
  if (hex.length !== 16 + 16 + 64 || !hex.startsWith(MAGIC)) return null;
  const seq = Number.parseInt(hex.slice(16, 32), 16);
  if (!Number.isSafeInteger(seq)) return null;
  return { seq, headHash: hex.slice(32) };
}
