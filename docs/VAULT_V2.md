# AgentVault v2: session keys and ERC-20

`contracts/AgentVaultV2.sol` is an **additive** contract. The deployed v1
(`AgentVault`, `0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388`) and every hash in
`docs/EXECUTION_EVIDENCE.md` are untouched; v2 lives at its own address.

## Why v2

v1 caps one agent key. If that key is stolen, the loss is bounded by one day's
limit — good, but the whole agent runs on a single long-lived key with the vault's
full budget. Session keys are the industry-standard next step: the owner hands the
agent a **short-lived key with its own, smaller budget**, and can revoke it at any
moment. A stolen session key is bounded twice over (its own caps *and* the vault's)
and can be killed without touching the owner or the vault limits.

v2 also closes the token gap: v1 only moves native ETH, so ERC-20 sends came
straight from the agent EOA and bypassed the on-chain caps. v2 adds
`agentSendToken` with a per-token daily limit.

## Model

```
owner (hardware wallet)                     agent / session key
  │  grantSessionKey, setLimits, ...            │  agentSend / agentSendToken
  ▼                                             ▼
AgentVaultV2 ── vault caps (native: maxPerTx, dailyLimit) ──┐
             ── allowedRecipient[] ──────────────────────────┤ every send is checked
             ── tokenRules[token] (allowed, dailyLimit) ─────┤ against ALL of these
             ── sessions[key] (expiry, caps, flags, targets) ┘
```

- **Root agent** (`agent`): v1 semantics — vault caps + allowlist only.
- **Session** (`sessions[key]`): its own `expiry`, native `maxPerTx`/`dailyLimit`,
  `canSendNative` / `canSendToken` selector flags, and an optional recipient
  restriction. Native caps must be `≤` the vault's at grant time.
- **Tokens**: `tokenRules[token]` has `allowed` and a `dailyLimit`; a session may
  only move a token if `sessionToken[key][token]` is set.

## Invariants (pinned by `test/contracts/AgentVaultV2.t.sol`)

1. **Caps never above the vault.** `grantSessionKey` reverts with
   `SessionCapsAboveVault` if `sessionMaxPerTx > maxPerTx` or
   `sessionDailyLimit > dailyLimit`. The send path *also* re-checks the vault caps,
   so **lowering a vault cap immediately tightens every live session**
   (`test_loweringVaultCapTightensExistingSession`).
2. **Empty target set is fail-closed.** A session with `targetsRestricted = true`
   pays only addresses in `sessionTarget`; with no targets it pays nobody
   (`test_restrictedSessionWithNoTargetsPaysNobody`). "Unrestricted" is the
   separate, explicit `targetsRestricted = false`; a recipient must always be on
   the vault allowlist too.
3. **Checks-effects-interactions + reentrancy guard.** Budgets are debited before
   any external call, and every spend runs under `nonReentrant`
   (`test_reentrancyIsBlocked`).

Plus fuzz tests: a mixed root+session ledger never exceeds the daily limit and
always equals what recipients received; any amount a session sends stays within
its cap; any time at/after expiry reverts; no grant can carry over-vault caps.

## Functions

Agent-callable (the only two):

| Function | Notes |
|---|---|
| `agentSend(address to, uint256 amount)` | **Identical signature to v1**, so `src/executor/executor.ts` routes through either vault unchanged. |
| `agentSendToken(address token, address to, uint256 amount)` | Needs an allowed token, `canSendToken` + `sessionToken[key][token]`, and the recipient rules. |

Owner-only: `grantSessionKey`, `revokeSessionKey`, `setSessionTarget`,
`setSessionToken`, `setAllowedToken`, `setPaused`, `setAgent`, `setLimits`,
`setRecipient`, `withdraw`, `withdrawToken`.

## Deploy and grant (owner key, off-band)

The owner key never enters the app — grants and limits are applied with Foundry /
`cast`:

```bash
# 1. Deploy (owner key signs; AGENT_ADDRESS is the root agent key)
export AGENT_ADDRESS=0x...
export VAULT_MAX_PER_TX=500000000000000      # 0.0005 ETH
export VAULT_DAILY_LIMIT=10000000000000000   # 0.01 ETH
export VAULT_FUNDING=10000000000000000       # fund the vault
forge script script/DeployAgentVaultV2.s.sol \
  --rpc-url $RPC_URL --private-key $OWNER_KEY --broadcast

# 2. Allow the recipient and (optionally) a token the vault will hold
cast send $VAULT "setRecipient(address,bool)" 0xAlice true --private-key $OWNER_KEY ...
cast send $VAULT "setAllowedToken(address,bool,uint256)" 0xUsdc true 1000000 --private-key $OWNER_KEY ...

# 3. Grant a 1-day session key with tighter caps, then give it a token
cast send $VAULT \
  "grantSessionKey(address,uint64,uint256,uint256,bool,bool,bool)" \
  $SESSION_KEY $(date -d '+1 day' +%s) 100000000000000 300000000000000 true false false \
  --private-key $OWNER_KEY ...
```

Then point the app at it:

```bash
VAULT=true VAULT_ADDRESS=$VAULT VAULT_TOKENS=true   # native + ERC-20 via the vault
```

## Tests

```bash
forge test                     # 12 (v1) + 37 (v2) = 49 tests, 4 fuzz
```

`lib/forge-std` is git-ignored; install it once with
`git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std`
(or `forge install foundry-rs/forge-std`).
