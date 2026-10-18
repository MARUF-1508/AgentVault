# Demo Script (5 minutes)

A rehearsed walkthrough of Agent Vault for judges. Every action below runs on
**Base Sepolia** and goes through the same policy engine; nothing in the demo
path can bypass it. Amounts are deliberately tiny (0.0001–0.0005 ETH).

**Before you start**

- `.env` has `AGENT_PRIVATE_KEY` (see README Setup step 2) and the wallet has a
  little Base Sepolia ETH. `npm run cli -- info` shows the balance.
- The web UI is built and running: `cd web && npm run build && cd .. && npm run cli -- serve`.
- If you have an LLM key configured, the chat segments work; if not, use the
  Transfer page tier preview (no LLM needed) — see *Zero-key fallback* below.
- Have `docs/EXECUTION_EVIDENCE.md` open in a second tab: it holds the live
  tx hashes you will reference (vault address, sends, reverts, x402 payment).

## 0:00 — Frame the problem (30 s, slides-free)

> "An AI agent can be prompt-injected or just wrong. We don't try to make the
> LLM trustworthy — we make its *permissions* deterministic. The LLM plans, a
> pure-function policy engine decides, the chain enforces."

Show the tier banner (T0–T3) in the README or the Security page.

## 0:30 — First look at the UI

1. Open `http://127.0.0.1:5174`, sign in as owner. (First run: create the
   owner account; optionally show **Settings → Security → two-factor** and the
   QR code, then cancel.)
2. Dashboard: balance, daily budget meter (`x / 0.01 ETH today`), audit
   integrity badge **chain intact**.
3. Security page: the **policy fingerprint** (sha256 of `config/policy.json`).
   > "Edit the policy and this hash changes — approvals are bound to the exact
   > policy in force."

## 1:00 — A normal day: allowlisted transfer auto-runs (T1)

On the **Transfer** page (no LLM involved):

1. Recipient: `alice` (allowlist label), amount `0.0001`, click **Check tier**.
2. Show the verdict card: **T1 auto** with reasons ("allowlisted recipient",
   "within per-tx limit", "within daily budget"), the simulated effect and gas.
3. Execute it. The audit timeline gets `intent → T1_AUTO → simulation →
   tx_sent → tx_confirmed`; click the explorer link.
   > "No human in the loop — and that is safe precisely because *this exact
   > action* was pre-authorized by policy."

## 1:45 — A new recipient needs a human (T2)

Still on Transfer page: amount `0.0002`, recipient = a fresh address you
control (not on the allowlist).

1. **Check tier** → **T2 confirm**: "new recipient", full address shown.
2. Execute → the **approval card** appears (only an owner can answer):
   type-to-confirm the address for a non-allowlisted recipient, then approve
   within two minutes.
3. Result: hash on screen. Then **reject** case: send an unanswered request and
   let it auto-reject after 2 minutes — "ambiguous consent fails closed."

## 2:45 — The interesting part: denial with a way forward (T3)

1. Ask the agent (chat panel) or Transfer page: send `0.5` ETH to alice.
2. **T3 denied** with reasons: "above hard per-tx cap (0.005)",
   "above remaining daily budget".
3. The agent does not just refuse — it proposes a compliant alternative
   ("would you like 0.0001 instead?") thanks to the system prompt + few-shots.
4. Bonus: paste a hostile memo from `test/injection.test.ts` into a *token
   name/memo* field context and show the policy still denies; the model treats
   tool output as `<untrusted>` data.
5. **"What if?" counterfactual**: `npm run cli -- whatif 0x2222222222222222222222222222222222222222 0.0002 --allow`
   shows the verdict today (T2, new recipient) beside the verdict if that
   recipient were already allowlisted (T1) — read-only, nothing is sent. The
   `what_if` agent tool answers the same question in chat.

## 3:45 — Kill switch + audit evidence

1. Click **Pause** in the UI (owner-only). Attempt any transfer → T3
   "paused". Resume from the CLI only: `npm run cli -- resume`.
   > "The UI can tighten, never loosen."
2. Activity page → **Export CSV**; show the hash-chained log.
   `npm run cli -- audit verify` prints **chain intact**.
3. `npm run evidence` regenerates `docs/EXECUTION_EVIDENCE.md`; open it: every
   hash in this file is a real Base Sepolia transaction from this repo.

## 4:30 — On-chain enforcement (the bonus differentiator)

1. Show `AgentVault` at `0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388` on
   basescan: funded, with the agent address, per-tx cap 0.0005 ETH, daily
   0.01 ETH, allowlist.
2. Show the two **reverted** over-limit and non-allowlisted direct calls in
   the evidence file.
   > "Even with the agent's private key fully stolen, the chain caps the loss
   > at one day's limit. Off-chain policy is the UX; on-chain limits are the
   > backstop."
3. Optional (30 s): x402 v2 paid API — `npm run x402:api` in one terminal,
   ask the agent for market data; the 0.0002 ETH payment is a normal
   `native_transfer` intent (T1), with its hash in the evidence file. The client
   speaks x402 v2 (CAIP-2 network, base64 `PaymentPayload` proof) and never
   re-pays a `settlement_pending` answer.
4. Optional (20 s): **task budget envelope** — `npm run cli -- send <to> 0.0005 --task demo --task-max 0.001`
   twice succeeds, a third is denied ("Task budget exceeded"), bounding one goal
   independently of the daily budget.

## Zero-key fallback (no LLM, no funded wallet)

Everything except live signing works offline against the real engine:

```bash
npm test                                   # full unit suite
npm run cli -- preview 0x4785Dca37A242F3D80f844CB0b143A687008a2B5 0.0002   # T1 + reasons
npm run cli -- preview 0x4785Dca37A242F3D80f844CB0b143A687008a2B5 1        # T3 + reasons
npm run cli -- whatif  0x2222222222222222222222222222222222222222 0.0002 --allow   # T2 → T1, nothing sent
npm run cli -- audit verify                # chain intact
cat docs/EXECUTION_EVIDENCE.md             # recorded live hashes
```

Then demo the UI read-only: dashboard, Security fingerprint, Activity export.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No AGENT_PRIVATE_KEY configured` | `npm run keygen`, fund the address from a Base Sepolia faucet |
| Transfer reverts "simulation failed" | Wallet out of ETH — `npm run cli -- info` |
| Chat does nothing | `LLM_API_KEY` missing — use Transfer page preview instead |
| Port already in use | `fuser -k 5174/tcp` or `npm run cli -- serve --port 6001` |
| Approval card expired | Approvals auto-reject after 2 minutes; resubmit |
