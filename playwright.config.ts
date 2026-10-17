import { defineConfig } from '@playwright/test';

/**
 * End-to-end smoke test against the real server and the built UI:
 * first-run setup -> dashboard -> policy preview (no transaction sent) ->
 * security page fingerprint. State lives in /tmp/opencode/av-e2e so a dev's
 * own users/audit files are never touched.
 */
const E2E_DIR = '/tmp/opencode/av-e2e';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:8931',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run cli -- serve 8931',
    url: 'http://127.0.0.1:8931/api/auth/setup',
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      USERS_FILE: `${E2E_DIR}/users.json`,
      AUDIT_LOG: `${E2E_DIR}/audit.jsonl`,
      PAUSE_FILE: `${E2E_DIR}/PAUSED`,
      SCHEDULES_FILE: `${E2E_DIR}/schedules.json`,
      VAULT: 'false',
    },
  },
});
