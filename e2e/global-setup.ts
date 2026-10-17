import { mkdirSync, rmSync } from 'node:fs';

/**
 * Runs once per `npm run e2e` (not again on worker restarts after a failure).
 * The server reads these files per request, so clearing them here is enough to
 * guarantee a first-run experience — and keeps a developer's real
 * data/users.json and data/audit.jsonl untouched.
 */
export default function globalSetup(): void {
  const dir = process.env.E2E_DIR ?? '/tmp/opencode/av-e2e';
  mkdirSync(dir, { recursive: true });
  rmSync(`${dir}/users.json`, { force: true });
  rmSync(`${dir}/audit.jsonl`, { force: true });
}
