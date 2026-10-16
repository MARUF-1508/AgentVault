# Agent Wallet

An AI wallet agent that autonomously executes on-chain operations (asset management, transaction execution, risk control) on **Base Sepolia**, behind a deterministic policy firewall the LLM cannot bypass.

> Built for the Shenzhen FinTech International Track, Topic F. See [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

**Core idea:** the LLM *plans*, a pure-function policy engine *decides*, the chain *enforces*.

```
you ─▶ LLM agent ─▶ tool (zod-validated) ─▶ policy engine ─▶ simulate ─▶ [human approve if T2] ─▶ sign ─▶ chain ─▶ audit log
```

| Tier | Meaning | Example |
|---|---|---|
| T0 | Read-only, always allowed | balances, policy, history |
| T1 | Auto-execute | ≤ 0.0005 ETH to an allowlisted address, within the daily budget |
| T2 | Human must approve | new recipient, or above the auto limit |
| T3 | Denied | above hard cap, over daily budget, denylisted, unlimited approval, wrong chain, paused |

---

## Setup

### Prerequisites
- Node.js **20 or newer** (`node -v`)
- An API key for any OpenAI-compatible LLM endpoint (only needed for `npm run agent`; the CLI works without one)

### 1. Install
```bash
git clone <your-repo-url> agent-wallet
cd agent-wallet
npm install
npm test            # 99 tests, no network needed
```

### 2. Create the agent's testnet wallet
```bash
npm run keygen
```
This creates `.env` from `.env.example`, generates a fresh key, stores it in `.env` (chmod 600, git-ignored) and prints the address. **Testnet only. Never put a key that holds real funds here.**

### 3. Fund it
Send a little Base Sepolia ETH to the printed address from any Base Sepolia faucet (Coinbase Developer Platform, Alchemy, QuickNode and others run one). For USDC, use Circle's testnet faucet (faucet.circle.com) and pick Base Sepolia.

```bash
npm run cli -- info             # should show your balance
npm run cli -- balance USDC
```

### 4. Configure the LLM (for chat mode)
Edit `.env`:
```bash
LLM_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible endpoint
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini                    # any model with tool calling
```

### 5. Set your policy
Edit `config/policy.json`. Add the addresses you trust to `recipients.allowlist` (label → address). Limits are human-readable decimal strings.

---

## Usage

```bash
npm run agent                                      # chat with the agent
npm run cli -- portfolio                           # all balances with USD value
npm run cli -- preview <to> 0.0001                 # which tier? nothing is sent
npm run cli -- send <to> 0.0001 --dry-run          # policy + simulation, nothing sent
npm run cli -- send <to> 0.0001                    # native ETH
npm run cli -- send <to> 0.5 USDC                  # ERC-20
npm run cli -- approve USDC <spender> 1            # bounded ERC-20 approval
npm run cli -- swap USDC WETH 2 50 --dry-run       # quote + policy, nothing sent (50 bps cap)
npm run cli -- swap USDC WETH 2 50                 # bounded approve + swap on the DEX
npm run cli -- schedule list                       # show scheduled / conditional rules
npm run cli -- schedule run                        # run any due rules (each through the executor)
npm run cli -- pause                               # kill switch: deny everything
npm run cli -- resume
npm run cli -- audit                               # last 20 audit entries
npm run cli -- audit verify                        # detect tampering
npm run cli -- serve [--port N]                    # web UI on http://127.0.0.1:5174 (loopback only)
npm run evidence                                   # docs/EXECUTION_EVIDENCE.md with tx hashes
```

Example chat:
```
you › send 0.0002 ETH to alice
  → get_policy({})
  → preview_transaction({"kind":"native_transfer","to":"0x…","amount":"0.0002"})
  → execute_transaction({...})
agent › Sent 0.0002 ETH to alice (T1, auto). Tx: https://sepolia.basescan.org/tx/0x…
```

### Web UI

```bash
cd web && npm install && npm run build
cd .. && npm run cli -- serve          # http://127.0.0.1:5174
```

Chat panel, portfolio card with budget limits, a T2 approval card (Approve/Reject
resolves the same executor queue as the CLI), and an audit timeline with a chain-
integrity badge. The server binds loopback only and has no auth: a local demo,
never expose it. See `web/README.md`.

### On-chain vault mode

With a deployed `AgentVault` holding funds, set in `.env`:

```bash
VAULT=true
VAULT_ADDRESS=0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388
```

Native transfers are then sent as zero-value `agentSend` calls paid out of the
vault, so the per-tx cap, daily limit and allowlist are re-enforced on-chain
(even a stolen agent key is capped). Policy evaluation is unchanged; ERC-20 and
swaps are unaffected. `VAULT=true` without `VAULT_ADDRESS` refuses to start.

---

## For judges: testing this project

No credentials are stored in this repo, by design (private keys are never
committed). Everything below is free: testnet faucets, any free
OpenAI-compatible LLM tier, Foundry, Vite.

**Zero-key path (2 minutes, no wallet, no LLM key):**

```bash
npm install && npm test                # 99 unit tests, offline
npm run cli -- preview 0x4785Dca37A242F3D80f844CB0b143A687008a2B5 0.0002   # T1 verdict, nothing sent
npm run cli -- preview 0x4785Dca37A242F3D80f844CB0b143A687008a2B5 1        # T3 verdict + reasons
npm run cli -- audit verify             # tamper check (empty log reads intact)
cat docs/EXECUTION_EVIDENCE.md          # our real testnet hashes + vault reverts
forge install foundry-rs/forge-std --no-commit && forge test   # 10 contract tests
```

**Full signing path (about 5 minutes, still free):** follow Setup steps 2–5
above (`npm run keygen`, fund from a Base Sepolia faucet, send 0.0001 ETH to an
address you control). All demo amounts are tiny on purpose.

**What maps to the scoring:** the demo script in
`docs/IMPLEMENTATION_PLAN.md` §6 (10 scenarios → task/security/interaction),
`docs/TECHNICAL.md` (architecture), `docs/SECURITY_SELF_ASSESSMENT.md`
(tiers + known risks), `docs/EXECUTION_EVIDENCE.md` (tx hashes).

---

## Project layout

```
src/
  index.ts              CLI entry
  config.ts             env + policy loading (zod)
  agent/agent.ts        LLM tool-calling loop, system prompt
  agent/tools.ts        tool definitions + validated dispatch
  agent/untrusted.ts    wraps external text as <untrusted> data (prompt-injection defence)
  policy/engine.ts      ★ the policy firewall (pure function)
  policy/types.ts       Policy, Intent, tiers, risk inputs
  policy/state.ts       daily spend + rate limit, derived from the audit log
  executor/executor.ts  policy → simulate → approve → sign → receipt → audit
  approval/approver.ts  human-in-the-loop: CLI prompt, WebApprover queue, DenyAll
  audit/log.ts          hash-chained, append-only JSONL log
  chain/client.ts       viem clients, mainnet guard
  chain/vault.ts        AgentVault ABI (agentSend)
  dex/uniswap.ts        Uniswap v3 quoter + swap calldata (swap intent)
  prices/price.ts       USD valuation: Chainlink feed, else labelled testnet table
  portfolio/portfolio.ts T0 read-only balances + USD total
  risk/address.ts       contract-code, block-list and address-poisoning checks
  report/evidence.ts    renders docs/EXECUTION_EVIDENCE.md from the audit log
  web/server.ts         loopback-only demo server (same executor, WebApprover)
  schedule/rules.ts     scheduled / conditional rule schema + due calculation
  schedule/runner.ts    runs due rules through the executor
contracts/AgentVault.sol  on-chain spending limits (challenge bonus)
web/                    Vite + React UI: chat, portfolio, approval card, timeline
script/DeployAgentVault.s.sol  Foundry deploy script
foundry.toml              Foundry config (AgentVault tests + deploy)
config/policy.json        limits, allowlists, swap router, prices, risk
config/schedules.json     scheduled / conditional rules (user config)
scripts/                  keygen, evidence
test/                     vitest unit tests
test/contracts/           Foundry tests for AgentVault
  docs/                     plan, technical doc, security self-assessment, evidence
```

### Asset management: swaps and schedules

- **Portfolio** (`get_portfolio` tool / `portfolio` command): every policy asset's balance with a USD value. Prices come from a Chainlink feed when one is configured in `policy.prices`, otherwise a clearly-labelled `fixed-testnet-table`. Read-only (T0).
- **Swap** (`execute_swap` tool / `swap` command): a `swap` intent priced by the Uniswap v3 QuoterV2. The engine derives the on-chain minimum output from the quote and the slippage cap, refuses anything above `swap.maxSlippageBps`, and only ever calls the allowlisted router. A bounded approval (exactly `amountIn`, never unlimited) is sent first and only if the current allowance is short, and that approval is itself a policy-checked intent.
- **Scheduled / conditional rules** (`config/schedules.json`): e.g. "send 1 USDC to Alice every Friday" or "move 50% to USDC if ETH drops 5%". Rules are user configuration (there is no LLM tool to write them); `npm run cli -- schedule run` turns each due rule into a normal `Intent` and runs it through the same executor. A rule that already fired today (per the audit log) is skipped. Rules ship disabled — enable them deliberately.

### Risk controls

Every state-changing action is checked against `config/policy.json` → `risk` in addition to the limits, and these findings can only **raise** the tier:

- **Address risk** (`src/risk/address.ts`, applied before T1/T2): is the target a contract (does it have code)? Is it on the local `blocklist`? Does it imitate an allowlisted address by sharing leading/trailing characters (address poisoning)? A block-listed or poisoning address is T3; a non-allowlisted contract is T2 (or T3 if `contractRecipients: "deny"`). The one chain read (`getCode`) happens in the executor; the engine stays a pure function.
- **Portfolio anomaly guard**: a single request whose USD value exceeds `maxActionPctOfPortfolio`% of the whole portfolio is refused (T3). Set it to `0` to disable.
- **Prompt-injection defence** (`src/agent/untrusted.ts`): every tool result is delivered to the model inside `<untrusted>…</untrusted>`, with any forged tags neutralised, and the system prompt marks it as data. `test/injection.test.ts` feeds a hostile memo ("ignore previous instructions…") and proves the policy still refuses the transfer and nothing is sent.

## Tests
```bash
npm test          # unit tests (vitest)
npm run typecheck
```
Every security claim in `docs/SECURITY_SELF_ASSESSMENT.md` should have a test. Add one with every new rule.

### Contract tests (Foundry)
`contracts/AgentVault.sol` enforces the caps on-chain, so a stolen agent key can't exceed them. Its tests live in `test/contracts/` and need [Foundry](https://book.getfoundry.sh/):
```bash
forge install foundry-rs/forge-std   # once
forge test                           # per-tx cap, daily reset, non-agent revert, pause, allowlist, owner-only
```

## Deploying AgentVault (stretch)
The vault is deployed by the **owner** (a key different from the agent's). With [Foundry](https://book.getfoundry.sh/):
```bash
forge install foundry-rs/forge-std --no-commit   # once per clone (lib/ is git-ignored)
forge test                                       # 10 contract tests, no network needed
export AGENT_ADDRESS=0x...                       # the agent's funded key
export VAULT_MAX_PER_TX=500000000000000          # 0.0005 ether
export VAULT_DAILY_LIMIT=10000000000000000       # 0.01 ether
export VAULT_FUNDING=10000000000000000           # optional
forge script script/DeployAgentVault.s.sol \
  --rpc-url https://sepolia.base.org --private-key <OWNER_KEY> --broadcast
```
Or the one-liner equivalent:
```bash
forge create contracts/AgentVault.sol:AgentVault \
  --rpc-url https://sepolia.base.org --private-key <OWNER_KEY> --broadcast \
  --value 0.01ether \
  --constructor-args <AGENT_ADDRESS> 500000000000000 10000000000000000
```

## Working on this with an AI coding agent
`AGENTS.md` holds the project rules and `.opencode/skills/agent-wallet/SKILL.md` is an opencode skill with the workflow. opencode picks both up automatically when run from the repo root.

## License
MIT
