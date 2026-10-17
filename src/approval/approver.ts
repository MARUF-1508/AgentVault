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
  summary: string;
  /** Epoch ms after which the request is auto-rejected. */
  expiresAt: number;
}

/**
 * Approver driven by the web UI instead of the terminal. `confirm` parks the
 * request until the UI answers via `decide` (approve/reject buttons on the T2
 * card). Concurrent requests are denied rather than queued, and a request that
 * nobody answers within `timeoutMs` is rejected: fail closed.
 */
export class WebApprover implements Approver {
  private pending: { summary: string; expiresAt: number; resolve: (ok: boolean) => void; timer: NodeJS.Timeout } | null = null;

  constructor(private readonly timeoutMs = 120_000) {}

  confirm(summary: string): Promise<boolean> {
    if (this.pending) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.decide(false), this.timeoutMs);
      this.pending = { summary, expiresAt: Date.now() + this.timeoutMs, resolve, timer };
    });
  }

  /** The currently waiting request, if any, for the UI to display. */
  getPending(): string | null {
    return this.pending?.summary ?? null;
  }

  /** The waiting request with its deadline, if any. */
  getPendingDetail(): PendingApproval | null {
    return this.pending ? { summary: this.pending.summary, expiresAt: this.pending.expiresAt } : null;
  }

  /** Resolve the waiting request. Returns false when nothing is waiting. */
  decide(approved: boolean): boolean {
    const waiting = this.pending;
    if (!waiting) return false;
    this.pending = null;
    clearTimeout(waiting.timer);
    waiting.resolve(approved);
    return true;
  }
}
