# Agent Wallet web UI (Day 4)

Local demo interface: chat panel, portfolio card with budget limits, T2 approval
card, and an audit timeline with a chain-integrity badge. Free tools only
(Vite + React, no paid services).

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
approval card polls `GET /api/pending` and answers with `POST /api/decide`.
A rejected approval resolves the executor with `rejected_by_human` and nothing
is signed (see `test/approver.test.ts`).

## Security note

The server binds **127.0.0.1 only and has no auth**. It is a local demo, not
hardened for hosting: never expose it beyond your machine. Every state change
still passes through the policy engine and the executor, exactly as in the CLI.
