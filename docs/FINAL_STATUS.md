# Final status: `feat/final-upgrade` (19 Oct 2026)

Branch `feat/final-upgrade`, cut from `origin/main` at `e32880c`. `main`
already contained `feat/ui-ux-refresh` (PR #2, 17 Oct: multipage UI, sign-in
and RBAC, voice) and PR #3 (AgentVaultV2, reservation ledger, x402 v2,
what-if), so nothing needed merging. No contract was changed and no evidence
hash was touched.

## Verified results (run on 19 Oct on Windows 11, Node 24)

| Check | Command | Result |
|---|---|---|
| Typecheck (agent, CLI, tests) | `npm run typecheck` | clean |
| Unit + integration tests | `npm test` | **304 passed / 304**, 36 files (baseline before this branch: 232 / 24 files) |
| Typecheck (web UI) | `npm --prefix web run typecheck` | clean |
| UI production build | `npm --prefix web run build` | built, no chunk-size warning (pages are lazy-loaded) |
| End-to-end + WCAG 2.2 AA | `npm run e2e` (locally with `PW_CHANNEL=msedge`) | **10 passed / 10**: 5 smoke flows, axe-core over the sign-in page and all 6 app pages in light **and** dark, keyboard contract, live region |
| Lockfiles | `npm ci` (root and `web/`) | installs cleanly, as CI will |
| Foundry contract tests | `forge test` | **not run locally** (Foundry is not installed on this machine). CI runs it in the `contracts` job; the last reported local run by the team was 49/49 (12 v1 + 37 v2) |
| Lint | — | no linter is configured in the repo; CI runs typecheck + tests + build + e2e + forge + docker build |
| Live testnet transactions | — | **none sent from this machine** (no `.env` here); see "Commands to run" |

## Feature list (the 20-item plan)

| ID | Feature | Status | Evidence |
|---|---|---|---|
| T1 | Compliant alternative computed by the engine | ✅ done | `src/policy/alternative.ts`, `test/alternative.test.ts`; shown in tools, `/api/preview`, CLI `preview`, Transfer page |
| T2 | Address book by name | ✅ done | `recipients.contacts`, `src/agent/resolve.ts` (did-you-mean, never guessed), Settings → Address book, `test/addressbook.test.ts` |
| T3 | Batch payments | ✅ done | `Executor.previewBatch/executeBatch`, `src/executor/batch.ts`, CLI `batch`, tools, `/api/batch*`, Transfer page, `test/batch-status.test.ts` |
| T4 | Tx status tracking | ✅ done | `Executor.txStatus/pendingTxs`, `tx_pending`, CLI `tx`/`pending`, `/api/tx*`, Activity page |
| T5 | Schedules in the background | ✅ done | `src/schedule/background.ts`, `SCHEDULER=true` in `serve`, `test/approvers-runtime.test.ts` |
| T6 | Rebalancing | ✅ done (planner) | `src/portfolio/rebalance.ts`, `plan_rebalance` tool; each step is a normal `execute_swap` |
| S1 | Budget mutex | ✅ done + bug fixed | reservation ledger kept; fixed the double count while a receipt is outstanding (regression test fails on the old code) |
| S2 | On-chain audit anchor | ✅ code + tests; ⏳ live tx | `src/audit/anchor.ts`, CLI `audit anchor` / `audit verify --onchain`, `test/anchor.test.ts` |
| S3 | ERC-20 vault | ✅ done (by the team) | `contracts/AgentVaultV2.sol`, `VAULT_TOKENS=true` |
| S4 | Policy file integrity | ✅ done | `POLICY_SHA256` pin, drift on `/api/status` + Security page, `test/integrity.test.ts` |
| S5 | Velocity guard | ✅ done | `rateLimit.velocity`, pure engine, `test/velocity.test.ts` |
| S6 | Decoded simulation on the approval card | ✅ done | `src/executor/decode.ts`, `Call` line on the card |
| S7 | Compliance export | ✅ done | `src/report/compliance.ts`, `GET /api/compliance`, Activity page button, `test/compliance.test.ts` |
| S8 | Redacted logs test | ✅ done | `src/audit/redact.ts`, `test/redact.test.ts` (agent key never reaches the audit file) |
| I2 | English + Chinese agent | ✅ done (unit-tested) | system prompt rule + `isChinese`, bilingual fallbacks; **not checked against a live model here** |
| I3 | x402 agent payment | ✅ done (by the team) | `src/x402.ts` |
| I4 | Telegram/email approver | ✅ Telegram (email not done) | `src/approval/telegram.ts`, tested with a fake Bot API; **not run against real Telegram** |
| B2 | ERC-4337 session key | ❌ not done | AgentVaultV2 owner-granted session keys remain the on-chain answer |

Known problems from the brief: stale plan checkboxes (updated, see
`docs/IMPLEMENTATION_PLAN.md` → "Final upgrade"); vault ETH-only (closed by V2);
concurrent overspend R6 (closed, plus the double-count fix); CSRF on the local
server (Host/Origin/JSON checks were already there; added a Fetch Metadata check
and `no-store`); hanging approvals (120 s timeout existed; added request ids so a
late answer can never approve a different request, and receipt timeouts now end
as `pending` instead of an unhandled throw).

## Other fixes and hardening in this branch

- Approval TOCTOU: `/api/decide` must name the pending request's id.
- Per-user rate limits (chat, transact, preview) with `Retry-After`; bounded chat memory; a model outage is a 503, not a crash.
- Agent loop: retries with backoff on 429/5xx/network errors, no half-finished tool exchange left in history, history trimmed safely, tier explanation on every result.
- Availability: RPC fallback transport, per-token fault tolerance in the portfolio, public `/api/health` (used by Docker and compose health checks and the UI network indicator).
- UI: MetaMask-style network indicator, RPC-down banner with retry, pending-tx tracker, batch card, address book, compliance download, policy integrity badges, lazy-loaded pages.
- WCAG 2.2 AA: skip link, focus traps + Escape + focus return on every dialog and the mobile drawer, keyboard account menu, live region, accessible names that contain the visible text, AA contrast fixes in both themes; enforced by axe in CI.
- CI: `.github/workflows/ci.yml` (typecheck, unit tests, UI typecheck + build, Playwright + axe, Foundry, Docker build), badge in the README.

## Commands to run with the funded key (on the machine that has `.env`)

None of these were run from here. They send real **testnet** transactions with
the agent key and cost only gas.

```bash
git fetch origin && git checkout feat/final-upgrade
npm ci && npm ci --prefix web && npm --prefix web run build

# 1. On-chain audit anchor (S2): zero-value self-tx carrying the audit head hash
npm run cli -- audit anchor
npm run cli -- audit verify --onchain          # expect: entry #N matches the on-chain anchor

# 2. Optional: a live batch of two tiny T1 transfers to alice
echo '[{"to":"alice","amount":"0.0001"},{"to":"alice","amount":"0.0001"}]' > /tmp/batch.json
npm run cli -- batch /tmp/batch.json --dry-run  # check first
npm run cli -- batch /tmp/batch.json

# 3. Regenerate the evidence doc (anchor and batch hashes appear in the table)
npm run evidence
git add docs/EXECUTION_EVIDENCE.md && git commit -m "docs(evidence): audit anchor and batch hashes"
```

Also worth doing before submitting:

- Check the first CI run on GitHub (Actions tab). If Actions is disabled for the
  repository, enable it once.
- With an LLM key: ask the agent `给 alice 转 0.0001 ETH` and `send 1 ETH to alice`
  to see the Chinese reply and the engine's alternative live.
- If anyone uses pnpm: `pnpm install` to refresh `pnpm-lock.yaml`
  (`@axe-core/playwright` was added with npm).

## What remains

- B2 (ERC-4337 session key) and the email approver are not implemented.
- The live anchor and batch hashes are not in `docs/EXECUTION_EVIDENCE.md` until the commands above are run.
- Foundry tests were not executed on this machine; CI runs them.
- The deck and the demo video are handled separately.
