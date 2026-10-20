# Final status: `main` (20 Oct 2026)

PR #4 merged `feat/final-upgrade` into `main` at `8898cac`. `main` already
contained `feat/ui-ux-refresh` (PR #2, 17 Oct: multipage UI, sign-in and RBAC,
voice) and PR #3 (AgentVaultV2, reservation ledger, x402 v2, what-if), so
nothing needed merging. No deployed contract was changed and no evidence hash
was touched.

The final commit before the deadline brings every CLI-only operation into the
web UI at the same security level: pause → resume (owner password again),
key generation/rotation, allowance approve/revoke, swap, scheduled rules,
what-if, the x402 demo and audit anchoring. The counts below include it.

## Verified results

| Check | Where | Result |
|---|---|---|
| Typecheck (agent, CLI, tests) | local, `npm run typecheck` | clean |
| Unit + integration tests | local, `npm test` | **324 passed / 324**, 40 files (baseline before this branch: 232 / 24 files) |
| Typecheck (web UI) | local, `npm --prefix web run typecheck` | clean |
| UI production build | local, `npm --prefix web run build` | built, no chunk-size warning (pages are lazy-loaded) |
| End-to-end + WCAG 2.2 AA | local, `npm run e2e` (bundled Chromium) | **14 passed / 14**: 9 smoke flows (incl. phone-width overflow guards, the agent hand-off layout and pause→resume with the password), axe-core over the sign-in page and all 7 app pages in light **and** dark, keyboard contract, live region |
| GitHub Actions CI | run `39403687188` on commit `2a77a17` | **all 4 jobs green**: typecheck/tests/UI build, e2e + axe (13/13), Foundry (69/69), Docker build |
| Foundry contract tests | CI `contracts` job and local `forge test` | **69 passed / 69** (AgentVault v1: 12, AgentVaultV2: 37, SessionKeyAccount: 20); Foundry was installed locally before the final run and the full suite passes there too |
| Lockfiles | local, `npm ci` (root and `web/`) | install cleanly |
| Lint | — | no linter is configured in the repo |
| Live testnet run | Base Sepolia, funded team key | **passed**: audit anchor + `--onchain` verify, 2-line batch, live EN/中文 agent replies, B2 deploy + session-key userOp (details below) |


## Live testnet evidence (produced 19 Oct 2026)

The funded team key was available during the final check, so the gaps listed in
the previous revision are now closed:

- **S2 audit anchor**: entry #175 anchored on-chain and verified:
  [`0x561f8a6a…`](https://sepolia.basescan.org/tx/0x561f8a6a4fb66e7d9021ac12359a8288118c1a8558b0803bc47090959cf53b6d).
  `audit verify --onchain` reports `entry #175 matches the on-chain anchor`.
- **Batch**: two T1 transfers, both confirmed:
  [`0xb6245068…`](https://sepolia.basescan.org/tx/0xb62450685da34f2794f92e1361d8c22e55ed4adfd0c80c28fedc582d3d8c39bc) and
  [`0xeca94314…`](https://sepolia.basescan.org/tx/0xeca9431472290ff0c1e5d8d663b74245e24ec1b0bcfa46321afdd3f6d214495c).
  `docs/EXECUTION_EVIDENCE.md` now lists 20 on-chain actions and 5 refusals.
- **I2 English + Chinese**: live model runs answered correctly in English
  (`0.0943940895 ETH and 17.5 USDC`) and in Simplified Chinese with the full
  portfolio, including WETH.
- **B2 ERC-4337**: `SessionKeyAccount` deployed at
  [`0x71c45789…`](https://sepolia.basescan.org/address/0x71c457899cd25f52e4e49dacdcc84f890c1ea98c)
  ([deploy](https://sepolia.basescan.org/tx/0x31ad639e74934e733b3a603f902671bbdd9bca9fa39c6393c16606f8fd237b78),
  [funding](https://sepolia.basescan.org/tx/0x3db8be2ed4451710ad97259be18cc6f0933aae6ae3153b6a54756c627d874c4a),
  [session grant](https://sepolia.basescan.org/tx/0x4b9b6c0706471b1508b8b01504fe5af7c478aec8c6c8583bf8f372107c84dbef)).
  A scoped session key
  (`0xB90498Ebe85736875d373Df6D228a4638AccbB30`, 0.0005 ETH/op, 0.01 ETH total,
  24 h, alice only) signed a user operation that was submitted through EntryPoint
  v0.7 via `handleOps`
  ([`0x164877c9…`](https://sepolia.basescan.org/tx/0x164877c9b480a2ac77fd5c14540b8df9562340f68f71ab212ae5423576d0d6c1),
  block 48328075, gas 139486). The tx emitted `SessionSpend` for 0.0001 ETH and
  `UserOperationEvent(success=true)`. No bundler API key was needed because the
  owner self-submitted the operation; any v0.7 bundler can relay the same op.

- **Wallet hygiene (found during the live run)**: the agent EOA carried an
  EIP-7702 delegation to MetaMask's stateless deleGator contract, which made any
  self-transaction with calldata revert. Plain ETH transfers were unaffected.
  The delegation was revoked with a type-4 authorization to the zero address
  ([`0x6f581f7a…`](https://sepolia.basescan.org/tx/0x6f581f7aa448db8c223e128afa26f71a70322c1f8eecb5db535492e6e25c62ef))
  before the batch run was recorded, so every on-chain step below ran on a plain
  EOA.

No Telegram/SMTP message was sent (the approvers are opt-in and were tested with
fakes); the live Telegram/SMTP paths remain untested by design.

## Feature list

The upgrade plan named 18 features (T1–T6, S1–S8, I2–I4, B2), all below. All 18
are implemented and tested, and every live part now has a Base Sepolia
transaction or run recorded (19 Oct).


| ID | Feature | Status | Evidence |
|---|---|---|---|
| T1 | Compliant alternative computed by the engine | ✅ done | `src/policy/alternative.ts`, `test/alternative.test.ts`; in tools, `/api/preview`, CLI `preview`, Transfer page |
| T2 | Address book by name | ✅ done | `recipients.contacts`, `src/agent/resolve.ts` (did-you-mean, never guessed), Settings → Address book, `test/addressbook.test.ts` |
| T3 | Batch payments | ✅ done | `Executor.previewBatch/executeBatch`, CLI `batch`, tools, `/api/batch*`, Transfer page, `test/batch-status.test.ts` |
| T4 | Tx status tracking | ✅ done | `Executor.txStatus/pendingTxs`, `tx_pending`, CLI `tx`/`pending`, `/api/tx*`, Activity page |
| T5 | Schedules in the background | ✅ done | `src/schedule/background.ts`, `SCHEDULER=true` in `serve` |
| T6 | Rebalancing | ✅ done (planner) | `src/portfolio/rebalance.ts`, `plan_rebalance`; each step is a normal `execute_swap` |
| S1 | Budget mutex | ✅ done + bug fixed | reservation ledger kept; fixed the double count while a receipt is outstanding |
| S2 | On-chain audit anchor | ✅ done + live | `src/audit/anchor.ts`, `audit anchor` / `audit verify --onchain`, `test/anchor.test.ts`; live tx `0x561f8a6a…`, entry #175 verified |
| S3 | ERC-20 vault | ✅ done (by the team) | `contracts/AgentVaultV2.sol`, `VAULT_TOKENS=true` |
| S4 | Policy file integrity | ✅ done | `POLICY_SHA256` pin, drift on `/api/status` + Security page |
| S5 | Velocity guard | ✅ done | `rateLimit.velocity`, `test/velocity.test.ts` |
| S6 | Decoded simulation on the approval card | ✅ done | `src/executor/decode.ts` |
| S7 | Compliance export | ✅ done | `GET /api/compliance`, Activity page |
| S8 | Redacted logs test | ✅ done | `src/audit/redact.ts`, `test/redact.test.ts` |
| I2 | English + Chinese agent | ✅ live-checked | live model runs answered in English and in Simplified Chinese (19 Oct) |
| I3 | x402 agent payment | ✅ done (by the team) | `src/x402.ts` |
| I4 | Telegram + email approvers | ✅ done (tested with fakes) | `src/approval/telegram.ts`, `src/approval/email.ts`, `test/approvers-runtime.test.ts`, `test/email-approver.test.ts`; not run against real Telegram/SMTP |
| B2 | ERC-4337 session key | ✅ deployed + live userOp | `contracts/SessionKeyAccount.sol` (EntryPoint v0.7: session keys scoped to targets, selectors, per-op and total value caps, expiry via `validUntil`), `src/aa/userop.ts`, `script/DeploySessionKeyAccount.s.sol`, 20 Foundry + 4 vitest tests sharing one hash vector. Deployed at `0x71c45789…`; a session-key userOp was executed via `handleOps` (tx `0x164877c9…`, `SessionSpend` + `UserOperationEvent(success=true)`) |

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
- UI reliability found by CI and reproduced under CPU throttling: a page transition that could leave the previous page on screen after a fast click; focus not returned to the opener when a dialog closed on a slow machine; a Tab pressed before focus entered a dialog escaping the trap; an uncancelled palette focus timer stealing focus after close.
- Per-user rate limits, bounded chat memory, model outage → 503, LLM retries with backoff.
- RPC fallback transport, per-token fault tolerance, public `/api/health`.
- UI: network indicator, RPC-down banner, pending-tx tracker, batch card, address book, compliance download, integrity badges, lazy pages.
- WCAG 2.2 AA enforced by axe in CI; keyboard-only operation; live regions.
- CI workflow with a badge in the README.

## What remains

- Nothing on the live-evidence plan: the anchor, batch, English/Chinese runs and
  B2 deployment + session-key userOp are recorded above. A bundler-relayed userOp
  is optional (the same op can be submitted by any v0.7 bundler).
- Telegram/SMTP messages against real services (opt-in paths, tested with fakes).
- The deck and demo video are handled separately.
