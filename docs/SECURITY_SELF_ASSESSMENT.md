# Security Self-Assessment

_Submission item 5: permission-tier implementation and known-risk list. Keep this honest and up to date; update the "Status" column as features land._

## 1. Trust boundaries

| Component | Trusted? | Why |
|---|---|---|
| User (terminal / web UI) | Yes, for T2 approvals | The human owner |
| LLM output and tool arguments | **No** | Can hallucinate or be prompt-injected. Everything is zod-validated and policy-checked. |
| External text (token names, memos, web pages, tool results) | **No** | Treated as data only |
| Policy engine | Yes | Pure, deterministic, unit-tested; the LLM has no tool to change it |
| Signer / agent key | Partially | Testnet hot key. Limits re-enforced on-chain by AgentVault (`agentSend`); v2 adds revocable, expiring session keys whose caps are always below the vault's |
| RPC provider | Partially | Could lie about state; simulation + receipt check reduce impact |

## 2. Permission tiers (implementation)

| Tier | Rule (see `src/policy/engine.ts`) | Test |
|---|---|---|
| T0 Read-only | Read tools (balances, portfolio, swap quote, policy, history) never reach the executor | `test/tools.test.ts`, `test/portfolio.test.ts`, `test/swap.test.ts` |
| T1 Auto | Allowlisted recipient, amount ≤ `autoMaxPerTx`, within `dailyBudget`; bounded approval to allowlisted spender; bounded swap within `autoMaxSlippageBps` and `autoMaxPerTx` | `policy.test.ts` "T1 auto", "swaps" |
| T2 Confirm | New recipient, or amount > `autoMaxPerTx`, or a non-allowlisted **contract** recipient (`risk.contractRecipients: confirm`); swap slippage above `autoMaxSlippageBps`; human types "yes" after seeing reasons; policy re-checked after approval | `policy.test.ts` "T2 confirm", "swaps", "Day 3 risk controls" |
| T3 Deny | Paused, wrong chain, rate limit, unknown token, zero/malformed amount, denylisted, **block-listed address**, **allowlisted-address lookalike (poisoning)**, **contract recipient when `risk.contractRecipients: deny`**, **single request above the portfolio anomaly share**, > `hardMaxPerTx`, over `dailyBudget`, unlimited approval, non-allowlisted spender; swap to an unknown/ non-allowlisted router, slippage above `maxSlippageBps`, no market quote, same token in/out | `policy.test.ts` "risk controls" + "swaps" + "Day 3 risk controls", `test/risk.test.ts` |

Evaluation order: kill switch → chain → rate limit → then **swaps**: policy → tokens → venue → spender allowlist → slippage cap → amount → hard cap → daily budget → anomaly guard → market quote → tier; or **transfers/approvals**: asset → amount → denylist → address risk (block list → poisoning → contract) → approval rules / hard cap → daily budget → known-recipient & auto-limit → anomaly guard → tier. Risk findings can only raise a tier, never lower it.

## 3. Controls

| Control | Status |
|---|---|
| Deterministic policy firewall outside the LLM | ✅ |
| Zod validation of every tool argument | ✅ |
| Tool dispatch is contained: non-object/malformed arguments are rejected and any integration error is returned to the model as data, never thrown into the agent loop | ✅ |
| Simulation (eth_call + estimateGas) before approval and signing | ✅ |
| Re-check policy after human approval (TOCTOU) | ✅ |
| Hash-chained tamper-evident audit log | ✅ |
| Budget derived from the audit log; failed txs still count | ✅ |
| Concurrent budget safety: an execution reserves its amount before re-checking and broadcasting, so a second concurrent request cannot spend the same budget (no overdraft) | ✅ |
| Kill switch (`pause`); the web UI can pause but only the CLI can resume, and both are audit-logged | ✅ |
| Web server refuses foreign `Host`/`Origin` and non-JSON POSTs (no cross-site approval or transfer); unanswered T2 approvals auto-reject after two minutes; a waiting T2 opens the approval dialog by itself and the owner may minimise it to read on (the top-bar pill reopens it), which changes nothing — the slot still expires server-side and fails closed, and only an owner can answer | ✅ |
| Web sign-in: scrypt-hashed passwords, HttpOnly SameSite=Strict session cookie, failed-login throttle; first-run setup creates the first owner, owners manage accounts (audited, sessions killed on removal), CLI also works | ✅ |
| Recipient allow/deny lists are editable only by an owner, over HTTP routes or the CLI, never by a tool the LLM can call. Hand-editing `config/policy.json` (the previous and only way) was unaudited and unchecked; every change now goes through the same audit log with the owner's name, and the policy fingerprint the UI shows is recomputed per request so it cannot go stale | ✅ |
| The two list edits that *lower* an address's tier (add a known recipient, un-deny one) need the owner's password again, not just the session. Writes are atomic (temp file + rename) and the serialised policy is re-parsed before the rename, so a crash cannot leave a file the engine cannot load. Adding an address that imitates an allowlisted one is refused (address poisoning) | ✅ |
| Role-based access checked server-side on every route: viewer reads, operator previews/transacts/chats, only owner approves T2 or pauses; sign-ins, approvals and pauses are audit-logged with the user name | ✅ |
| Voice input only fills the chat box; approvals always need an owner's click | ✅ |
| Mainnet refused unless explicitly enabled | ✅ |
| Key never printed; `.env` chmod 600 and git-ignored | ✅ |
| Unlimited ERC-20 approvals forbidden | ✅ |
| Swaps priced by the DEX quoter; the engine derives the on-chain minimum output and caps slippage; only the allowlisted router is called | ✅ |
| Swap approvals are bounded to exactly `amountIn`, never unlimited, and go through the engine themselves | ✅ |
| Scheduled rules are user config (no LLM write path); each run becomes a normal intent through the executor | ✅ |
| Prompt-injection defence: all tool output delimited as `<untrusted>` with forged tags neutralised; system prompt marks it as data | ✅ |
| Address risk: contract-code check, local block list and address-poisoning lookalikes raise/deny before signing | ✅ |
| Portfolio anomaly guard: a single request above `risk.maxActionPctOfPortfolio`% of total value is refused | ✅ |
| On-chain limits (AgentVault): deployed at `0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388` (Base Sepolia), 0.0005 ETH/tx, 0.01 ETH/day; over-limit agent call reverted on-chain; Foundry tests 12/12 (incl. 2 fuzz tests) | ✅ |
| On-chain limits v2 (`contracts/AgentVaultV2.sol`): delegated **session keys** — owner-granted, short-lived, capped below the vault's own caps, revocable — plus ERC-20 (`agentSendToken`). A stolen session key is bounded by its own budget *and* the vault's; the vault re-checks its caps on every send, so lowering a vault cap immediately tightens every live session. 37 Foundry tests including 4 fuzz tests (session caps can never exceed the vault's, an expired session always reverts, a mixed root+session ledger never exceeds the daily limit, no grant can carry over-vault caps) | ✅ |
| Vault-routing mode (`VAULT=true`): native transfers execute as zero-value `agentSend` calls, so payouts come from the pre-funded vault under on-chain caps; with `VAULT_TOKENS=true` against a v2 vault, ERC-20 transfers execute as `agentSendToken` calls, so the token cap applies on-chain too; proven live (`0xd7bc3fab…`) | ✅ |
| Second factor and session hygiene: owner can enable TOTP 2FA (RFC 6238, constant-time compare, tested against published vectors); sessions are 8 h absolute / 30 min idle; a TOTP change or account removal revokes sessions; "sign out all devices" in Settings | ✅ |
| Browser hardening: CSP (same-origin scripts, one hash-pinned inline snippet), `nosniff`, `no-referrer`, `X-Frame-Options: DENY` on every response; audit trail exports as CSV for review (`GET /api/audit/export`, read permission) | ✅ |
| x402-style paid API (v2-conformant): request origin pinned to `X402_API_URL` (SSRF guard), `402` requirements zod-validated (accepts v1 `maxAmountRequired` and v2 `amount`), the offer is picked by **CAIP-2** network, proof is sent as a base64 v2 `PaymentPayload` in `X-PAYMENT`, and a `settlement_pending` answer is treated as non-terminal (the broadcast hash is preserved and the request is **never retried** — no double charge). The payment is a normal `native_transfer` intent through the executor (T1/T2/T3 apply); fetched text treated as untrusted | ✅ |
| Task budget envelope: a goal can be given its own spending cap (CLI `--task <id> --task-max <amount>`); the executor sums that task's prior sends from the audit log and the engine refuses any transfer or swap that would cross the cap, independently of the daily budget. A failed (reverted) tx still counts, so the envelope cannot be reset by retrying | ✅ |
| Stale-allowance cleanup: `approve(spender, 0)` (CLI `revoke`, or an `erc20_approve` whose amount is `0`) is always allowed because it can only *shrink* what a spender may take — even for a spender that is not on the allowlist — so a dangerous standing allowance can be removed without weakening the allowlist; it still needs the token to be in policy and counts toward the rate limit | ✅ |
| Counterfactual "what-if" (`whatif` CLI, `what_if` read-only tool): evaluates the same intent under a hypothesis (recipient allowlisted, different limits, already spent, paused) without signing or changing anything; pure over the same policy engine | ✅ |
| Containerized deployment publishes on the host loopback only (`127.0.0.1:8787`); `.env` excluded from the image; `config/` mounted read-only | ✅ |
| Static analysis: Slither 0.11.6 on `contracts/AgentVault.sol` — **0 high/medium** findings, 8 informational (dispositions in §5) | ✅ |

## 4. Known-risk list

| # | Risk | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|
| R1 | Agent hot key stolen from `.env` | Low | Attacker bypasses off-chain policy | Testnet only; in `VAULT=true` mode funds sit in AgentVault, which caps on-chain loss to one day's limit even for a stolen key (proven: over-limit and non-allowlisted calls revert) | In default (EOA) mode the key still moves funds directly; route value through the vault |
| R2 | Prompt injection makes the LLM propose a malicious transfer | Medium | Attempted theft | Policy firewall; tool output wrapped as `<untrusted>`; new recipients are T2; amounts capped | A human could approve a bad T2 if they don't read the card |
| R3 | Human approval fatigue | Medium | Bad T2 approved | Plain-English reasons, small auto limits so T2 is rare | Social engineering of the human |
| R4 | Audit log deleted entirely | Low | Daily budget resets | Hash chain detects edits, not full deletion | Stretch: anchor the head hash on-chain periodically |
| R5 | Malicious RPC returns false simulation | Low | Wasted gas or misleading preview | Receipt status checked; use a reputable RPC | Not fully mitigated |
| R6 | Concurrent requests race the daily budget | Low | Overspend | An in-memory reservation ledger: an execution holds its amount against the budget from the re-check until it broadcasts, and the reserve plus re-check run in one synchronous step, so a second concurrent execution sees the first's reservation and cannot double-spend the budget (`test/executor.test.ts`) | The ledger is per-process; two server processes over one audit log would still race (not a supported deployment) |
| R7 | LLM misreads amounts/units | Medium | Wrong amount | Human-readable decimals only, zod regex, preview tool, hard caps | Bounded by caps |
| R8 | Allowlisted address itself is compromised | Low | Funds to attacker | Daily budget bounds loss | Not detectable by us |
| R17 | An owner (or someone with a stolen owner session) allowlists an attacker address | Medium | Small transfers to it become T1 and need no per-transaction approval | Adding a known recipient is an audited, owner-only action that re-checks the password; lookalike addresses are refused; the agent cannot call it; every change is logged with the owner's name | An owner who deliberately adds a bad address defeats their own approval gate; that is the owner acting against themselves |
| R9 | Dependency supply-chain attack (npm) | Low | Key exfiltration | Lockfile, few dependencies, `npm audit` | Inherent |
| R10 | Uniswap v3 liquidity on Base Sepolia is thin or absent, so a swap reverts or quotes to zero | Medium | Swap demo fails, wasted gas | Proven live twice (bounded approve + swap, hashes in evidence); the engine still refuses a swap with no valid quote, and quotes are shown before signing | Testnet quotes can be far from market; never present them as fair value |
| R11 | Address-poisoning detection is a heuristic (matching leading/trailing hex digits), so a carefully crafted near-miss could evade it | Low | Funds to a lookalike | New (non-allowlisted) recipients are still T2, so a human sees the full address before approving | Social engineering of the human remains |
| R12 | The anomaly guard uses the same price source as the portfolio; a missing or manipulated price disables or skews it | Low | A large request slips the guard | Hard caps and daily budgets always apply; prices are labelled (`chainlink`/`fixed-testnet-table`) and the guard is off only when a price is genuinely missing | On mainnet, oracle manipulation is a real residual |
| R13 | The local block list is static and cannot know a brand-new scam address | Medium | Interaction with a fresh scam | New recipients are T2; block list + denylist raise known-bad addresses to T3 immediately | Inherent to any local list |
| R14 | Someone else on the machine, or a web page, drives the local web UI | Low (loopback-only) | A T2 approved or a transfer sent by the wrong person | Sign-in with roles, so only an owner can approve or pause; optional TOTP 2FA and 30-min idle session timeout; binds 127.0.0.1 only; refuses non-loopback `Host` and `Origin` and non-JSON POSTs (`test/web.test.ts`); README warns never to expose it | Plain HTTP on loopback; sessions are in memory; a stolen owner password (without 2FA) still approves within the policy caps |
| R15 | Spoken commands are misheard | Medium | Wrong amount or recipient requested | Voice only types into the chat; the request still goes through the policy engine, and every T2 shows the full details and needs an owner's click | A misheard T1 within the auto limit to an allowlisted recipient can execute |
| R16 | In `VAULT=true` mode v1 only routes native ETH; ERC-20 transfers would still come from the agent EOA | Low | A stolen key could move tokens beyond the daily budget (bounded by the token balance and the off-chain policy) | `AgentVaultV2` adds `agentSendToken`, and `VAULT_TOKENS=true` routes ERC-20 transfers through it so the on-chain token cap applies; v1 stays native-only and is the default. Off-chain token limits, allowlist and simulation still gate every transfer | Until a v2 vault is actually deployed and `VAULT_ADDRESS` points at it, v1 deployments keep the residual |
| R18 | Content fetched from the x402 paid API is attacker-controlled text | Low | Attempted prompt injection from paid data | Delivered to the model as `<untrusted>` data like every tool result; the payment itself is policy-gated; fake `402` fields are rejected by the zod schema | Same residual as R2 (a human could still be socially engineered) |

## 5. Static analysis (Slither)

Run on the frozen, deployed contract (no redeploy — the deployed bytecode and
the source in `contracts/AgentVault.sol` stay identical):

```bash
python3 -m venv /tmp/slither && /tmp/slither/bin/pip install slither-analyzer
slither . --filter-paths "lib|test|script"     # Slither 0.11.6
# 8 results, all informational; 0 high / 0 medium
```

| Finding | Slither severity | Disposition |
|---|---|---|
| `missing-zero-check` — constructor `_agent` and `setAgent(a)` accept `address(0)` | Low/informational | Accepted. Setting a zero agent only disables the agent path (`msg.sender != agent` can never pass); owner can fix with `setAgent`. The contract is frozen post-deploy to keep evidence hashes valid. |
| `reentrancy-events` — `AgentSpend` emitted after `to.call` | Informational | Accepted. State (`spentToday`) is updated **before** the external call (checks-effects-interactions); a reentrant call is rejected by `msg.sender != agent`. Only the event ordering is flagged. |
| `timestamp` — `block.timestamp` in the daily-window comparison | Informational | Accepted. The ±few-seconds drift a validator can introduce is irrelevant at a 0.01 ETH/day scale; there is no randomness or payout based on exact time. |
| `low-level-calls` — `to.call{value}` and `owner.call{value}` | Informational | Accepted. Both check the success flag and revert with `TransferFailed`; low-level call is required to pay arbitrary EOA recipients. |
| `naming-convention` — `_maxPerTx`, `_dailyLimit` params | Informational | Accepted, cosmetic (leading-underscore parameters). |
| `solc-version pragma` aggregate note and misc. info | Informational | `pragma solidity ^0.8.24`; built by Foundry with the pinned solc in `foundry.toml`. |

### AgentVaultV2 (not deployed)

`AgentVaultV2.sol` is a new file, so the v1 address and its hashes above are
untouched. `forge test` is green (37 tests, 4 fuzz). Foundry's built-in linter
raises only warnings, all accepted:

| Lint | Disposition |
|---|---|
| `reentrancy-no-eth` on `IERC20(token).transfer` | Accepted (heuristic). The call sits inside the `nonReentrant` modifier, which sets `_locked = 1` before the body; the linter does not model the modifier. |
| `unsafe-typecast` (`uint64(block.timestamp)`, `uint64(expiry)` in tests) | Accepted. Timestamps fit in `uint64` for any realistic horizon; the cast is deliberate to pack the session struct. |
| `block-timestamp` in the expiry / daily-window comparisons | Accepted, same reasoning as v1: no randomness or exact-time payout. |
| `missing-zero-check` on owner setters | Accepted. A zero `agent`/session merely disables that path (fail closed); owner-only. |
| `reentrancy-events` (spend event after the external call) | Accepted. State is written before the call (checks-effects-interactions); a re-entrant spend is rejected by the guard. |

