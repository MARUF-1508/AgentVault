import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditLog } from '../audit/log.js';

/**
 * Kill switch. The pause file is read by `spendStateFrom`, so once it exists
 * every intent is T3 until it is removed. Both directions are audit-logged.
 * Pausing is offered to the CLI and the local web UI (it can only make the
 * wallet safer); resuming is CLI-only. The LLM gets neither.
 */
export function pauseWallet(pauseFile: string, audit: AuditLog, by: 'cli' | 'web', user?: string): void {
  mkdirSync(dirname(pauseFile), { recursive: true });
  writeFileSync(pauseFile, new Date().toISOString());
  audit.append('kill_switch', user ? { paused: true, by, user } : { paused: true, by });
}

export function resumeWallet(pauseFile: string, audit: AuditLog): void {
  rmSync(pauseFile, { force: true });
  audit.append('kill_switch', { paused: false, by: 'cli' });
}
