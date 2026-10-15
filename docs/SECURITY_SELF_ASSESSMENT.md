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
| T0 Read-only | Read tools never reach the executor | `test/tools.test.ts` |
| T1 Auto | Allowlisted recipient, amount ≤ `autoMaxPerTx`, within `dailyBudget`; bounded approval to allowlisted spender | `policy.test.ts` "T1 auto" |
| T2 Confirm | New recipient, or amount > `autoMaxPerTx`; human types "yes" after seeing reasons; policy re-checked after approval | `policy.test.ts` "T2 confirm" |
| T3 Deny | Paused, wrong chain, rate limit, unknown token, zero/malformed amount, denylisted, > `hardMaxPerTx`, over `dailyBudget`, unlimited approval, non-allowlisted spender | `policy.test.ts` risk controls |

Evaluation order: kill switch → chain → rate limit → asset → amount → denylist → approval rules → hard cap → daily budget → recipient/auto-limit → tier.

## 3. Controls

| Control | Status |
|---|---|
| Deterministic policy firewall outside the LLM | ✅ |
| Zod validation of every tool argument | ✅ |
| Simulation (eth_call + estimateGas) before approval and signing | ✅ |
| Re-check policy after human approval (TOCTOU) | ✅ |
| Hash-chained tamper-evident audit log | ✅ |
| Budget derived from the audit log; failed txs still count | ✅ |
| Kill switch (`pause`) | ✅ |
| Mainnet refused unless explicitly enabled | ✅ |
| Key never printed; `.env` chmod 600 and git-ignored | ✅ |
| Unlimited ERC-20 approvals forbidden | ✅ |
| Prompt-injection defence (untrusted-data wrapping + test) | ⏳ Day 3 |
| Address-poisoning / lookalike detection | ⏳ Day 3 |
| Contract-recipient and risk-list checks | ⏳ Day 3 |
| On-chain limits (AgentVault) | ⏳ Day 5 |

## 4. Known-risk list

| # | Risk | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|
| R1 | Agent hot key stolen from `.env` | Low | Attacker bypasses off-chain policy | Testnet only; AgentVault caps on-chain loss to one day's limit | Off-chain limits don't apply to a stolen key until the vault is used |
| R2 | Prompt injection makes the LLM propose a malicious transfer | Medium | Attempted theft | Policy firewall; new recipients are T2; amounts capped | A human could approve a bad T2 if they don't read the card |
| R3 | Human approval fatigue | Medium | Bad T2 approved | Plain-English reasons, small auto limits so T2 is rare | Social engineering of the human |
| R4 | Audit log deleted entirely | Low | Daily budget resets | Hash chain detects edits, not full deletion | Stretch: anchor the head hash on-chain periodically |
| R5 | Malicious RPC returns false simulation | Low | Wasted gas or misleading preview | Receipt status checked; use a reputable RPC | Not fully mitigated |
| R6 | Concurrent requests race the daily budget | Low | Slight overspend | Re-check before signing; single-process CLI | Needs a lock for a multi-user server |
| R7 | LLM misreads amounts/units | Medium | Wrong amount | Human-readable decimals only, zod regex, preview tool, hard caps | Bounded by caps |
| R8 | Allowlisted address itself is compromised | Low | Funds to attacker | Daily budget bounds loss | Not detectable by us |
| R9 | Dependency supply-chain attack (npm) | Low | Key exfiltration | Lockfile, few dependencies, `npm audit` | Inherent |
