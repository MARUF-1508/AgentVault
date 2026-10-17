# Agent Vault web UI (Day 4)

Local demo interface. Free tools only (Vite + React, no paid services).

- **Header**: chain, wallet address, vault or direct mode, model status, and a
  **Pause wallet** button (kill switch). Resuming is CLI-only on purpose.
- **Chat**: suggested prompts that match the demo script, the agent's tool calls
  under each answer, and clickable explorer links for hashes and addresses.
- **Portfolio**: balances with USD value and meters for today's spend against
  each daily budget and the hourly rate limit.
- **Policy check**: pick an amount, asset and recipient and see the tier and
  reasons without the LLM; T1 and T2 results can then be submitted to the
  executor.
- **Approval dialog**: action, amount, target address split into groups (the
  first and last groups highlighted, to make address poisoning visible), reasons
  as a list, and a countdown. Reject has focus by default and Escape rejects.
- **Audit trail**: readable entries, tier badges, explorer links, filters, and
  the hash-chain badge. Refreshes every few seconds.

## Run it

```bash
cd web && npm install
npm run build            # produces dist/, served by the wallet server
cd .. && npm run cli -- serve
```

Open http://127.0.0.1:5174. For hot-reload frontend work, run `npm run dev`
in `web/` (port 5173, proxies `/api` to the wallet server).

## How approvals work

T2 transactions park in a shared `WebApprover` queue on the server. The
approval dialog polls `GET /api/pending` and answers with `POST /api/decide`.
A rejected approval resolves the executor with `rejected_by_human` and nothing
is signed (see `test/approver.test.ts`). A request nobody answers within two
minutes is rejected the same way.

## Security note

The server binds **127.0.0.1 only and has no auth**. It is a local demo, not
hardened for hosting: never expose it beyond your machine. It refuses requests
whose `Host` or `Origin` is not loopback and POSTs that are not
`application/json`, so another website open in the same browser cannot approve
a T2 or send a transaction through it. Every state change
still passes through the policy engine and the executor, exactly as in the CLI.
