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
npm test            # 55 tests, no network needed
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

---

## Project layout

```
src/
  index.ts              CLI entry
  config.ts             env + policy loading (zod)
  agent/agent.ts        LLM tool-calling loop, system prompt
  agent/tools.ts        tool definitions + validated dispatch
  policy/engine.ts      ★ the policy firewall (pure function)
  policy/types.ts       Policy, Intent, tiers
  policy/state.ts       daily spend + rate limit, derived from the audit log
  executor/executor.ts  policy → simulate → approve → sign → receipt → audit
  approval/approver.ts  human-in-the-loop (CLI now, web later)
  audit/log.ts          hash-chained, append-only JSONL log
  chain/client.ts       viem clients, mainnet guard
  dex/uniswap.ts        Uniswap v3 quoter + swap calldata (swap intent)
  prices/price.ts       USD valuation: Chainlink feed, else labelled testnet table
  portfolio/portfolio.ts T0 read-only balances + USD total
  schedule/rules.ts     scheduled / conditional rule schema + due calculation
  schedule/runner.ts    runs due rules through the executor
contracts/AgentVault.sol  on-chain spending limits (challenge bonus)
config/policy.json        limits, allowlists, swap router, prices
config/schedules.json     scheduled / conditional rules (user config)
scripts/                  keygen, evidence
test/                     vitest
docs/                     plan, security self-assessment, evidence
```

### Asset management: swaps and schedules

- **Portfolio** (`get_portfolio` tool / `portfolio` command): every policy asset's balance with a USD value. Prices come from a Chainlink feed when one is configured in `policy.prices`, otherwise a clearly-labelled `fixed-testnet-table`. Read-only (T0).
- **Swap** (`execute_swap` tool / `swap` command): a `swap` intent priced by the Uniswap v3 QuoterV2. The engine derives the on-chain minimum output from the quote and the slippage cap, refuses anything above `swap.maxSlippageBps`, and only ever calls the allowlisted router. A bounded approval (exactly `amountIn`, never unlimited) is sent first and only if the current allowance is short, and that approval is itself a policy-checked intent.
- **Scheduled / conditional rules** (`config/schedules.json`): e.g. "send 1 USDC to Alice every Friday" or "move 50% to USDC if ETH drops 5%". Rules are user configuration (there is no LLM tool to write them); `npm run cli -- schedule run` turns each due rule into a normal `Intent` and runs it through the same executor. A rule that already fired today (per the audit log) is skipped. Rules ship disabled — enable them deliberately.

## Tests
```bash
npm test          # unit tests
npm run typecheck
```
Every security claim in `docs/SECURITY_SELF_ASSESSMENT.md` should have a test. Add one with every new rule.

## Deploying AgentVault (stretch)
With [Foundry](https://book.getfoundry.sh/):
```bash
forge create contracts/AgentVault.sol:AgentVault \
  --rpc-url https://sepolia.base.org --private-key <OWNER_KEY> --broadcast \
  --constructor-args <AGENT_ADDRESS> 500000000000000 10000000000000000 \
  --value 0.01ether
```
The owner key should be a different key from the agent key.

## Working on this with an AI coding agent
`AGENTS.md` holds the project rules and `.opencode/skills/agent-wallet/SKILL.md` is an opencode skill with the workflow. opencode picks both up automatically when run from the repo root.

## License
MIT
