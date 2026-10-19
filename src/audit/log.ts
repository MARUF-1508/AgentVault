import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from './redact.js';

export type AuditType =
  | 'intent'        // the agent asked for something
  | 'decision'      // the policy engine's verdict
  | 'approval'      // a human approved or rejected
  | 'simulation'    // pre-flight simulation result
  | 'tx_sent'       // broadcast, with hash
  | 'tx_confirmed'  // mined, with receipt status
  | 'tx_failed'
  | 'tx_pending'    // broadcast, receipt not seen in time (still counts to budget)
  | 'anchor'        // audit head committed on-chain (S2)
  | 'schedule'      // a scheduled/conditional rule fired
  | 'kill_switch'
  | 'access';       // web-UI sign-in, approval or pause by a named user

export interface AuditEntry {
  seq: number;
  ts: string;
  type: AuditType;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

const stringify = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

function hashEntry(e: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256')
    .update(stringify({ seq: e.seq, ts: e.ts, type: e.type, data: e.data, prevHash: e.prevHash }))
    .digest('hex');
}

/**
 * Append-only, hash-chained JSONL log. Each entry commits to the previous one,
 * so editing or deleting any line breaks verify(). This is both the audit trail
 * and the single source of truth for daily spend.
 */
export class AuditLog {
  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {
    mkdirSync(dirname(path), { recursive: true });
  }

  read(): AuditEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEntry);
  }

  append(type: AuditType, data: Record<string, unknown>): AuditEntry {
    const entries = this.read();
    const last = entries.at(-1);
    const base = {
      seq: (last?.seq ?? -1) + 1,
      ts: this.now().toISOString(),
      type,
      // Secrets never reach the file, even if an error message echoes one (S8).
      data: JSON.parse(stringify(redact(data))) as Record<string, unknown>,
      prevHash: last?.hash ?? GENESIS,
    };
    const entry: AuditEntry = { ...base, hash: hashEntry(base) };
    appendFileSync(this.path, JSON.stringify(entry) + '\n');
    return entry;
  }

  /** Returns the seq of the first broken entry, or null if the chain is intact. */
  verify(): { ok: true } | { ok: false; brokenAt: number; reason: string } {
    let prev = GENESIS;
    for (const [i, e] of this.read().entries()) {
      if (e.seq !== i) return { ok: false, brokenAt: i, reason: 'sequence gap' };
      if (e.prevHash !== prev) return { ok: false, brokenAt: i, reason: 'prevHash mismatch' };
      const { hash, ...rest } = e;
      if (hashEntry(rest) !== hash) return { ok: false, brokenAt: i, reason: 'content hash mismatch' };
      prev = hash;
    }
    return { ok: true };
  }
}
