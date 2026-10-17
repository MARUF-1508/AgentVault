# Technical Documentation

_Submission item 1: architecture, core algorithm, security design. For the build
order and schedule see `docs/IMPLEMENTATION_PLAN.md`; for threats see
`docs/SECURITY_SELF_ASSESSMENT.md`._

## 1. Architecture

The LLM **plans**, a deterministic policy engine **decides**, the chain
**enforces**. The model can propose anything but can only ever execute what the
policy allows, because the only signing path runs through the firewall.

```
User (CLI chat / Web UI / chat API)
        │ natural language
        ▼
┌──────────────┐  tool calls (JSON, untrusted)  ┌────────────────────┐
│  LLM agent   │ ─────────────────────────────▶ │ Tool layer (zod)   │
│  (planner)   │ ◀────────────────────────────── │ validates every arg│
│ agent.ts     │     results (data only)         │ tools.ts           │
└──────────────┘                                └─────────┬──────────┘
                                                          │ Intent
                                                          ▼
                                               ┌─────────────────────┐
                                               │ Policy engine (pure)│
                                               │ engine.ts: T1 / T2 /│
                                               │ T3 + reasons        │
                                               └─────────┬───────────┘
                                         T3 deny ◀────────┤
                                                          ▼
                                               ┌─────────────────────┐
                                               │ Executor            │
                                               │ simulate (eth_call  │
                                               │ + estimateGas)      │
                                               └─────────┬───────────┘
                                                         │
                                         T2 ──▶ Human approval (CLI /
                                               WebApprover card)
                                                         │
                                                         ▼
                                               Re-check policy (TOCTOU)
                                                         │
                                                         ▼
                                               Signer (only key holder)
                                                         │
                                                         ▼
                                      Base Sepolia → receipt → hash-chained audit log
                                                                └─▶ EXECUTION_EVIDENCE.md
Stretch: payments route through AgentVault.sol, which re-enforces caps on-chain.
```

### Module map

| Path | Role |
|---|---|
| `src/agent/agent.ts` | LLM tool-calling loop + injection-aware system prompt |
| `src/agent/tools.ts` | Tool definitions, zod-validated dispatch; swaps forced onto `execute_swap` |
| `src/agent/untrusted.ts` | `<untrusted>` envelope, forged-tag stripping |
| `src/policy/types.ts` | `Policy`, `Intent`, `Tier`, zod schemas (addresses checksummed, amounts decimal strings) |
| `src/policy/engine.ts` | **The firewall.** Pure function `(intent, policy, state, chainId, market?) → Decision` |
| `src/policy/state.ts` | `SpendState` rebuilt from the audit log (budgets, rate limit, pause flag) |
| `src/risk/address.ts` | Chain-aware address checks (bytecode, block list, lookalikes); findings only raise tiers |
| `src/dex/uniswap.ts` | Uniswap v3 quoter read + swap calldata encoder |
| `src/portfolio/portfolio.ts` | T0 balances with labelled USD valuation |
| `src/prices/price.ts` | Fixed, clearly-labelled testnet price table |
| `src/schedule/rules.ts`, `runner.ts` | User-configured scheduled/conditional rules; each run becomes an `Intent` through the executor |
| `src/executor/executor.ts` | **Only signer.** preview → simulate → approve → re-check → sign → receipt → audit |
| `src/approval/approver.ts` | `CliApprover` (terminal), `WebApprover` (UI queue), `DenyAllApprover` (tests/T1-only) |
| `src/audit/log.ts` | Append-only hash-chained JSONL log; also the budget source of truth |
| `src/report/evidence.ts` | Pure renderer for `EXECUTION_EVIDENCE.md` (audit txs + externally-observed vault hashes) |
| `src/chain/client.ts` | viem clients + mainnet refusal guard |
| `src/web/server.ts` | Loopback-only UI server: sign-in, role checks per route, same executor, `WebApprover` instead of CLI |
| `src/auth/rbac.ts`, `src/auth/users.ts` | Roles and permissions (pure); scrypt user store, sessions and login throttle |
| `src/config.ts` | zod-validated env + policy loading |
| `contracts/AgentVault.sol` | On-chain per-tx cap, daily limit, recipient allowlist, pause (owner = human) |

## 2. Core algorithm: policy evaluation order

`evaluate()` is intentionally ordered from cheapest global kill-switches to
per-recipient judgement. The first matching rule wins; evaluation is total
(every intent gets exactly one tier with reasons).

1. **Kill switch** — `state.paused` → T3.
2. **Chain** — connected `chainId !== policy.chainId` → T3.
3. **Rate limit** — `txLastHour >= maxTxPerHour` → T3.
4. **Asset resolution** — unknown token → T3 (deny by default).
5. **Amount parsing** — `parseUnits` failure or `<= 0` → T3. Amounts are
   human-readable decimal strings at the edges, `bigint` base units inside;
   JS `number` is never used for money.
6. **Denylist / blocklist** → T3 (case-insensitive, checksummed compare).
7. **Approval rules** — unlimited forbidden → T3; non-allowlisted spender → T3;
   over hard cap → T3; over auto limit → T2; else T1.
8. **Swap rules** (deny by default) — swaps disabled / unknown token /
   self-swap / wrong venue / over max slippage / no quoter market → T3; over
   auto slippage or over auto amount or contract-risk findings → T2; else T1
   with engine-derived `minAmountOut`.
9. **Hard cap** — amount over `hardMaxPerTx` → T3 (never approvable).
10. **Daily budget** — `spentToday + amount > dailyBudget` → T3. Spend is
    derived from `tx_sent` entries, and broadcast-but-failed txs still count,
    so retries cannot drain past the budget.
11. **Anomaly guard** — single request over `risk.maxActionPctOfPortfolio`% of
    portfolio USD value → T3.
12. **Address risk** (computed before `evaluate`, passed in as data so the
    engine stays pure) — blocklisted → T3; lookalike of an allowlisted address
    (address poisoning) → T3 with the impersonated address named;
    contract recipient → raised to at least T2 (configurable).
13. **Recipient + auto limit** — unknown recipient or amount over
    `autoMaxPerTx` → T2 with reasons; otherwise T1.

Risk findings can only **raise** a tier, never lower one.

### Swap execution (two on-chain steps, both gated)

`execute_swap` validates the whole swap first (a denied swap sends no
approval), then: (1) bounded `approve` of exactly `amountIn` to the
allowlisted router — itself an `Executor.execute` call, policy-checked and
logged; (2) the swap with the engine-derived minimum output — again through
`Executor.execute` (simulate → approve → re-check → sign → receipt → audit).

### Schedules

`config/schedules.json` holds user-written rules (interval or price-drop
triggers). `schedule run` evaluates them; a due rule becomes a normal `Intent`
executed through the same pipeline (dry-run supported). The LLM has no tool
that writes schedules.

## 3. Security design

- **One signing path.** `Executor.execute` is the only code that touches
  `walletClient.sendTransaction`, and it calls `evaluate` twice (before
  approval and immediately before signing). There is no back door.
- **Untrusted model output.** Every tool argument is zod-validated; tool
  results and all external strings (token names, memos, revert reasons) are
  wrapped as `<untrusted>` data and never concatenated into instructions.
- **Human in the loop.** T2 parks on `Approver.confirm` (terminal prompt or
  web card showing action, amount, target, chain, tier, reasons). A rejection
  resolves `rejected_by_human` with nothing signed and no `tx_sent` entry
  (proven by `test/approver.test.ts`).
- **Tamper-evident memory.** Each audit entry hashes the previous one;
  `audit verify` detects edits (`sequence gap`, `prevHash mismatch`, `content
  hash mismatch`). Budgets derive from this log, not from mutable state.
- **Fail closed.** RPC failures in risk checks are treated as "is a
  contract"; concurrent web approvals are denied, not queued, and an
  unanswered one is rejected after two minutes; unknown tokens, venues and
  chains are denied.
- **Local UI is not a browser back door.** The web server refuses a
  non-loopback `Host` (DNS rebinding), a non-loopback `Origin` (another
  website) and any POST that is not `application/json`, so a page in the
  same browser cannot approve a T2 or trigger a transfer. The UI can pause the
  wallet but not resume it; resuming stays CLI-only.
- **Testnet only.** `chain.client.ts` refuses mainnet unless explicitly
  enabled; keys live in git-ignored `.env` (chmod 600) and are never printed,
  logged or committed. Unlimited approvals are forbidden by policy.
- **Defence in depth on-chain.** `AgentVault.sol` re-enforces per-tx and daily
  caps plus an allowlist even if the agent key is fully compromised; the worst
  case is one day's limit. Over-limit and non-allowlisted calls revert
  on-chain (hashes in `EXECUTION_EVIDENCE.md`).
