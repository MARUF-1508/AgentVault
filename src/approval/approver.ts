import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/** Human-in-the-loop for T2 transactions. Swap for a web/Telegram approver later. */
export interface Approver {
  confirm(summary: string): Promise<boolean>;
}

export class CliApprover implements Approver {
  async confirm(summary: string): Promise<boolean> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(`\n⚠️  Approval required\n${summary}\nApprove this transaction? Type "yes" to approve: `);
      return answer.trim().toLowerCase() === 'yes';
    } finally {
      rl.close();
    }
  }
}

/** Never approves. Useful for tests and fully autonomous (T1-only) runs. */
export class DenyAllApprover implements Approver {
  async confirm(): Promise<boolean> {
    return false;
  }
}

/** What the web UI shows for a waiting T2 request. */
export interface PendingApproval {
  /** Unique per request: a decision must name the request it answers. */
  id: string;
  summary: string;
  /** Epoch ms after which the request is auto-rejected. */
  expiresAt: number;
}

/**
 * Something told about each new T2 request, e.g. a Telegram bot (I4). It may
 * answer later through `WebApprover.decide(approved, id)`, which is the single
 * place a decision is made, so every channel gets the same id check and timeout.
 */
export interface ApprovalNotifier {
  notify(pending: PendingApproval): void | Promise<void>;
  /** Called when the request is decided or expires, so the channel can update itself. */
  settled?(id: string, approved: boolean, by: string): void | Promise<void>;
}

/**
 * Approver driven by the web UI instead of the terminal. `confirm` parks the
 * request until the UI answers via `decide` (approve/reject buttons on the T2
 * card). Concurrent requests are denied rather than queued, and a request that
 * nobody answers within `timeoutMs` is rejected: fail closed.
 *
 * Every request carries an id, and a decision that names a different id is
 * ignored. Without it, an owner looking at request A could approve request B
 * that replaced A after A timed out (a time-of-check/time-of-use race).
 */
export class WebApprover implements Approver {
  private pending: (PendingApproval & { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }) | null = null;
  private readonly notifiers: ApprovalNotifier[] = [];
  /** Who answered the last decided request (web user, telegram, timeout). */
  lastDecidedBy: string | null = null;

  constructor(private readonly timeoutMs = 120_000) {}

  addNotifier(n: ApprovalNotifier): void {
    this.notifiers.push(n);
  }

  confirm(summary: string): Promise<boolean> {
    if (this.pending) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => this.decide(false, id, 'timeout'), this.timeoutMs);
      this.pending = { id, summary, expiresAt: Date.now() + this.timeoutMs, resolve, timer };
      const detail = { id, summary, expiresAt: this.pending.expiresAt };
      for (const n of this.notifiers) void Promise.resolve(n.notify(detail)).catch(() => {});
    });
  }

  /** The currently waiting request, if any, for the UI to display. */
  getPending(): string | null {
    return this.pending?.summary ?? null;
  }

  /** The waiting request with its id and deadline, if any. */
  getPendingDetail(): PendingApproval | null {
    return this.pending ? { id: this.pending.id, summary: this.pending.summary, expiresAt: this.pending.expiresAt } : null;
  }

  /**
   * Resolve the waiting request. Returns false when nothing is waiting, or when
   * `id` is given and names a different (older) request.
   */
  decide(approved: boolean, id?: string, by = 'web'): boolean {
    const waiting = this.pending;
    if (!waiting) return false;
    if (id !== undefined && id !== waiting.id) return false;
    this.pending = null;
    clearTimeout(waiting.timer);
    this.lastDecidedBy = by;
    waiting.resolve(approved);
    for (const n of this.notifiers) void Promise.resolve(n.settled?.(waiting.id, approved, by)).catch(() => {});
    return true;
  }
}
