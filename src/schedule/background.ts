import { runDueRules, type RunResult, type ScheduleDeps } from './runner.js';

export interface SchedulerStatus {
  enabled: boolean;
  intervalSec: number;
  lastRunAt: string | null;
  lastResults: RunResult[];
  lastError: string | null;
}

/**
 * Background runner for scheduled / conditional rules while `serve` is up (T5).
 * Every tick runs `runDueRules`, which sends each due rule through the Executor,
 * so the policy engine decides each one and a T2 rule waits for an owner in the
 * UI like any other request. Ticks never overlap, and a failing tick is recorded
 * and retried on the next one instead of stopping the loop. The audit log makes
 * re-running safe: a rule that already fired today is skipped.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  readonly status: SchedulerStatus;

  constructor(
    private readonly deps: () => ScheduleDeps,
    intervalSec: number,
    private readonly run: typeof runDueRules = runDueRules,
  ) {
    this.status = { enabled: false, intervalSec, lastRunAt: null, lastResults: [], lastError: null };
  }

  /** One tick. Exposed for tests; returns null when a tick is already in flight. */
  async tick(now?: Date): Promise<RunResult[] | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const results = await this.run(this.deps(), now ? { now } : {});
      this.status.lastResults = results;
      this.status.lastError = null;
      return results;
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message : String(err);
      return [];
    } finally {
      this.status.lastRunAt = new Date().toISOString();
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.status.enabled = true;
    this.timer = setInterval(() => void this.tick(), this.status.intervalSec * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status.enabled = false;
  }
}
