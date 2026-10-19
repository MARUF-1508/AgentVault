# Final status: `feat/final-upgrade` (19 Oct 2026)

Branch `feat/final-upgrade`, cut from `origin/main` at `e32880c`. `main`
already contained `feat/ui-ux-refresh` (PR #2, 17 Oct: multipage UI, sign-in
and RBAC, voice) and PR #3 (AgentVaultV2, reservation ledger, x402 v2,
what-if), so nothing needed merging. No contract was changed and no evidence
hash was touched.

## Verified results

| Check | Where | Result |
|---|---|---|
| Typecheck (agent, CLI, tests) | local, `npm run typecheck` | clean |
| Unit + integration tests | local, `npm test` | **314 passed / 314**, 38 files (baseline before this branch: 232 / 24 files) |
| Typecheck (web UI) | local, `npm --prefix web run typecheck` | clean |
| UI production build | local, `npm --prefix web run build` | built, no chunk-size warning (pages are lazy-loaded) |
| End-to-end + WCAG 2.2 AA | local, `npm run e2e` with `PW_CHANNEL=msedge` | **10 passed / 10**: 5 smoke flows, axe-core over the sign-in page and all 6 app pages in light **and** dark, keyboard contract, live region |
| GitHub Actions CI | run `39200521759` on commit `73cc57a` | **all 4 jobs green**: typecheck/tests/UI build, e2e + axe, Foundry, Docker build |
| Foundry contract tests | CI `contracts` job | **69 passed / 69** (AgentVault v1: 12, AgentVaultV2: 37, SessionKeyAccount: 20). Not run locally: Foundry is not installed on this machine; the new contract was compile-checked locally with solc 0.8.28 |
| Lockfiles | local, `npm ci` (root and `web/`) | install cleanly |
| Lint | — | no linter is configured in the repo |


## Live testnet evidence: not produced (blocked)

The planned live steps were an audit anchor, its on-chain verification, a small
live batch, a regenerated evidence doc and an ERC-4337 deployment. None of these
could run on the build machine:

- There is **no `.env`** in `E:\Project\AgentVault` (only `.env.example`), so
  there is no agent key, no LLM key and no Telegram/SMTP configuration.
- The local `data/audit.jsonl` is empty; `npm run cli -- audit anchor` answers
  `{"error": "The audit log is empty; nothing to anchor."}`, and with an entry it
  would stop at `No AGENT_PRIVATE_KEY configured; wallet is read-only.`
- Creating and funding a new key needs a faucet, which means solving a CAPTCHA;
  that is not something to automate.

So: **no transaction hashes were added**, `docs/EXECUTION_EVIDENCE.md` is
unchanged, and the live English/Chinese agent check was not done (no LLM key).
No Telegram token is configured, so nothing was sent there either.

To produce the evidence, the same commands have to run on the machine whose
`.env` holds the funded Base Sepolia key (any team member's):

```bash
git fetch origin && git checkout feat/final-upgrade
npm ci && npm ci --prefix web && npm --prefix web run build
npm run cli -- info                            # confirm Base Sepolia (84532) and a funded address
npm run cli -- audit anchor                    # zero-value self-tx carrying the audit head hash
npm run cli -- audit verify --onchain          # expect: entry #N matches the on-chain anchor
echo '[{"to":"alice","amount":"0.0001"},{"to":"alice","amount":"0.0001"}]' > /tmp/batch.json
npm run cli -- batch /tmp/batch.json --dry-run # both lines T1
npm run cli -- batch /tmp/batch.json
npm run evidence
git add docs/EXECUTION_EVIDENCE.md && git commit -m "docs(evidence): audit anchor and batch hashes"
git push origin feat/final-upgrade

# Optional (B2): deploy the ERC-4337 account with the OWNER key and grant the agent a session
OWNER_ADDRESS=0x... SESSION_KEY=<agent address> SESSION_RECIPIENT=0x4785Dca37A242F3D80f844CB0b143A687008a2B5   forge script script/DeploySessionKeyAccount.s.sol --rpc-url https://sepolia.base.org --private-key <OWNER_KEY> --broadcast
```

## Feature list

The upgrade plan named 18 features (T1–T6, S1–S8, I2–I4, B2), all below. All 18
are implemented and tested. Three have a live part that still needs the funded
key: the S2 anchor transaction, the I2 check against a real model, and the B2
deployment.


| ID | Feature | Status | Evidence |
|---|---|---|---|
| T1 | Compliant alternative computed by the engine | ✅ done | `src/policy/alternative.ts`, `test/alternative.test.ts`; in tools, `/api/preview`, CLI `preview`, Transfer page |
| T2 | Address book by name | ✅ done | `recipients.contacts`, `src/agent/resolve.ts` (did-you-mean, never guessed), Settings → Address book, `test/addressbook.test.ts` |
| T3 | Batch payments | ✅ done | `Executor.previewBatch/executeBatch`, CLI `batch`, tools, `/api/batch*`, Transfer page, `test/batch-status.test.ts` |
| T4 | Tx status tracking | ✅ done | `Executor.txStatus/pendingTxs`, `tx_pending`, CLI `tx`/`pending`, `/api/tx*`, Activity page |
| T5 | Schedules in the background | ✅ done | `src/schedule/background.ts`, `SCHEDULER=true` in `serve` |
| T6 | Rebalancing | ✅ done (planner) | `src/portfolio/rebalance.ts`, `plan_rebalance`; each step is a normal `execute_swap` |
| S1 | Budget mutex | ✅ done + bug fixed | reservation ledger kept; fixed the double count while a receipt is outstanding |
| S2 | On-chain audit anchor | ✅ code + tests; ❌ live tx | `src/audit/anchor.ts`, `audit anchor` / `audit verify --onchain`, `test/anchor.test.ts`; live hash blocked (see above) |
| S3 | ERC-20 vault | ✅ done (by the team) | `contracts/AgentVaultV2.sol`, `VAULT_TOKENS=true` |
| S4 | Policy file integrity | ✅ done | `POLICY_SHA256` pin, drift on `/api/status` + Security page |
| S5 | Velocity guard | ✅ done | `rateLimit.velocity`, `test/velocity.test.ts` |
| S6 | Decoded simulation on the approval card | ✅ done | `src/executor/decode.ts` |
| S7 | Compliance export | ✅ done | `GET /api/compliance`, Activity page |
| S8 | Redacted logs test | ✅ done | `src/audit/redact.ts`, `test/redact.test.ts` |
| I2 | English + Chinese agent | ✅ unit-tested; ❌ not live-checked | no LLM key on this machine |
| I3 | x402 agent payment | ✅ done (by the team) | `src/x402.ts` |
| I4 | Telegram + email approvers | ✅ done (tested with fakes) | `src/approval/telegram.ts`, `src/approval/email.ts`, `test/approvers-runtime.test.ts`, `test/email-approver.test.ts`; not run against real Telegram/SMTP |
| B2 | ERC-4337 session key | ✅ code + tests; ❌ not deployed | `contracts/SessionKeyAccount.sol` (EntryPoint v0.7 account: session keys scoped to targets, selectors, per-op and total value caps, expiry via `validUntil`), `src/aa/userop.ts` (v0.7 hash, signing, scope from `config/policy.json`), `script/DeploySessionKeyAccount.s.sol`, 20 Foundry + 4 vitest tests sharing one hash vector. Not deployed or used through a live bundler (no funded key) |

Known problems from the brief: plan checkboxes updated truthfully; vault
ETH-only closed by V2; concurrent overspend closed plus the double-count fix;
CSRF hardened (Fetch Metadata, `no-store`, the only non-JSON POST is the signed
email-confirm form); hanging approvals fixed with request ids and `pending`
receipts.

## Email approver design (I4)

- Configured by `SMTP_URL`, `APPROVAL_EMAIL_FROM`, `APPROVAL_EMAIL_TO`, optional `APPROVAL_LINK_SECRET` (≥ 32 chars; unset = new secret per restart) and `PUBLIC_BASE_URL`.
- Each T2 is mailed with approve/reject links signed with HMAC-SHA256 over `id|action|expiry`. A link works for one request, once, until that request's existing approval timeout.
- Opening a link only renders a confirmation page (mail scanners prefetch links); the page's same-origin form POST decides through `WebApprover.decide(approved, id)`, so the executor still re-checks the policy before signing, and T3 can never be approved.
- Links only work where the owner's browser reaches the UI (the server is loopback-only). Risk R23 in the security self-assessment.

## Other fixes and hardening in this branch

- Approval TOCTOU: `/api/decide` must name the pending request's id.
- Per-user rate limits, bounded chat memory, model outage → 503, LLM retries with backoff.
- RPC fallback transport, per-token fault tolerance, public `/api/health`.
- UI: network indicator, RPC-down banner, pending-tx tracker, batch card, address book, compliance download, integrity badges, lazy pages.
- WCAG 2.2 AA enforced by axe in CI; keyboard-only operation; live regions.
- CI workflow with a badge in the README.

## What remains

- Live anchor + batch hashes in `docs/EXECUTION_EVIDENCE.md` (needs the funded key; commands above).
- Live check of the agent in English and Chinese (needs an LLM key).
- B2 live deployment of the ERC-4337 account and one session-key user operation through a v0.7 bundler (needs the funded key and a bundler endpoint).
- The deck and demo video are handled separately.
