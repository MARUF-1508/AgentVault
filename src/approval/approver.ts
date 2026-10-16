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

/**
 * Approver driven by the web UI instead of the terminal. `confirm` parks the
 * request until the UI answers via `decide` (approve/reject buttons on the T2
 * card). Concurrent requests are denied rather than queued: fail closed.
 */
export class WebApprover implements Approver {
  private pending: { summary: string; resolve: (ok: boolean) => void } | null = null;

  confirm(summary: string): Promise<boolean> {
    if (this.pending) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.pending = { summary, resolve };
    });
  }

  /** The currently waiting request, if any, for the UI to display. */
  getPending(): string | null {
    return this.pending?.summary ?? null;
  }

  /** Resolve the waiting request. Returns false when nothing is waiting. */
  decide(approved: boolean): boolean {
    const waiting = this.pending;
    if (!waiting) return false;
    this.pending = null;
    waiting.resolve(approved);
    return true;
  }
}
