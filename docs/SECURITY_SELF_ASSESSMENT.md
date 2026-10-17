# Security Self-Assessment

_Submission item 5: permission-tier implementation and known-risk list. Keep this honest and up to date; update the "Status" column as features land._

## 1. Trust boundaries

| Component | Trusted? | Why |
|---|---|---|
| User (terminal / web UI) | Yes, for T2 approvals | The human owner |
| LLM output and tool arguments | **No** | Can hallucinate or be prompt-injected. Everything is zod-validated and policy-checked. |
| External text (token names, memos, web pages, tool results) | **No** | Treated as data only |
| Policy engine | Yes | Pure, deterministic, unit-tested; the LLM has no tool to change it |
| Signer / agent key | Partially | Testnet hot key. Stretch: limits re-enforced on-chain by AgentVault |
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
| Kill switch (`pause`); the web UI can pause but only the CLI can resume, and both are audit-logged | ✅ |
| Web server refuses foreign `Host`/`Origin` and non-JSON POSTs (no cross-site approval or transfer); unanswered T2 approvals auto-reject after two minutes | ✅ |
| Web sign-in: scrypt-hashed passwords, HttpOnly SameSite=Strict session cookie, failed-login throttle; first-run setup creates the first owner, owners manage accounts (audited, sessions killed on removal), CLI also works | ✅ |
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
| On-chain limits (AgentVault): deployed at `0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388` (Base Sepolia), 0.0005 ETH/tx, 0.01 ETH/day; over-limit agent call reverted on-chain; Foundry tests 10/10 | ✅ |
| Vault-routing mode (`VAULT=true`): native transfers execute as zero-value `agentSend` calls, so payouts come from the pre-funded vault under on-chain caps; proven live (`0xd7bc3fab…`) | ✅ |

## 4. Known-risk list

| # | Risk | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|
| R1 | Agent hot key stolen from `.env` | Low | Attacker bypasses off-chain policy | Testnet only; in `VAULT=true` mode funds sit in AgentVault, which caps on-chain loss to one day's limit even for a stolen key (proven: over-limit and non-allowlisted calls revert) | In default (EOA) mode the key still moves funds directly; route value through the vault |
| R2 | Prompt injection makes the LLM propose a malicious transfer | Medium | Attempted theft | Policy firewall; tool output wrapped as `<untrusted>`; new recipients are T2; amounts capped | A human could approve a bad T2 if they don't read the card |
| R3 | Human approval fatigue | Medium | Bad T2 approved | Plain-English reasons, small auto limits so T2 is rare | Social engineering of the human |
| R4 | Audit log deleted entirely | Low | Daily budget resets | Hash chain detects edits, not full deletion | Stretch: anchor the head hash on-chain periodically |
| R5 | Malicious RPC returns false simulation | Low | Wasted gas or misleading preview | Receipt status checked; use a reputable RPC | Not fully mitigated |
| R6 | Concurrent requests race the daily budget | Low | Slight overspend | Re-check before signing; single-process CLI | Needs a lock for a multi-user server |
| R7 | LLM misreads amounts/units | Medium | Wrong amount | Human-readable decimals only, zod regex, preview tool, hard caps | Bounded by caps |
| R8 | Allowlisted address itself is compromised | Low | Funds to attacker | Daily budget bounds loss | Not detectable by us |
| R9 | Dependency supply-chain attack (npm) | Low | Key exfiltration | Lockfile, few dependencies, `npm audit` | Inherent |
| R10 | Uniswap v3 liquidity on Base Sepolia is thin or absent, so a swap reverts or quotes to zero | Medium | Swap demo fails, wasted gas | Proven live twice (bounded approve + swap, hashes in evidence); the engine still refuses a swap with no valid quote, and quotes are shown before signing | Testnet quotes can be far from market; never present them as fair value |
| R11 | Address-poisoning detection is a heuristic (matching leading/trailing hex digits), so a carefully crafted near-miss could evade it | Low | Funds to a lookalike | New (non-allowlisted) recipients are still T2, so a human sees the full address before approving | Social engineering of the human remains |
| R12 | The anomaly guard uses the same price source as the portfolio; a missing or manipulated price disables or skews it | Low | A large request slips the guard | Hard caps and daily budgets always apply; prices are labelled (`chainlink`/`fixed-testnet-table`) and the guard is off only when a price is genuinely missing | On mainnet, oracle manipulation is a real residual |
| R13 | The local block list is static and cannot know a brand-new scam address | Medium | Interaction with a fresh scam | New recipients are T2; block list + denylist raise known-bad addresses to T3 immediately | Inherent to any local list |
| R14 | Someone else on the machine, or a web page, drives the local web UI | Low (loopback-only) | A T2 approved or a transfer sent by the wrong person | Sign-in with roles, so only an owner can approve or pause; binds 127.0.0.1 only; refuses non-loopback `Host` and `Origin` and non-JSON POSTs (`test/web.test.ts`); README warns never to expose it | Plain HTTP on loopback; sessions are in memory; a stolen owner password still approves within the policy caps |
| R15 | Spoken commands are misheard | Medium | Wrong amount or recipient requested | Voice only types into the chat; the request still goes through the policy engine, and every T2 shows the full details and needs an owner's click | A misheard T1 within the auto limit to an allowlisted recipient can execute |
| R16 | In `VAULT=true` mode only native ETH is routed through AgentVault; ERC-20 transfers still come from the agent EOA, so on-chain caps do not cover tokens | Medium | A stolen key could move tokens beyond the daily budget (bounded by the token balance and the off-chain policy) | Off-chain token limits, allowlist, budgets and simulation still gate every transfer; keep token balances in the agent wallet small in vault deployments; the agent path always goes through the policy engine | Roadmap: a token-aware vault (`agentSendToken`) that re-enforces caps for ERC-20 |
