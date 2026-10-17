# Agent Vault web UI

A local multipage interface built with free tools only: Vite, React, React
Router, Framer Motion, lucide-react icons, Sonner toasts, React Markdown (GFM
tables in chat) and React CountUp for animated numbers.

## Run it

```bash
cd web && npm install
npm run build            # produces dist/, served by the wallet server
cd .. && npm run cli -- serve
```

Open http://127.0.0.1:5174. While no accounts exist, the sign-in page shows a
first-run setup form that creates the first `owner` and signs in. After that,
owners add teammates (username + role, one-time generated password) from
**Settings → Team**. The CLI also works:

```bash
npm run cli -- user add alice operator   # prints a generated password
npm run cli -- user list
npm run cli -- user remove alice
```

For hot-reload frontend work, run `npm run dev` in `web/` (port 5173, proxies
`/api` to the wallet server).

## Pages

| Page | What it shows |
|---|---|
| Dashboard | KPIs (budget used, rate limit, kill switch, audit chain), holdings, spend meters, recent activity |
| Agent | Chat with suggested prompts, markdown-formatted replies (tables, lists, linked tx hashes), the agent's tool calls, push-to-talk voice and spoken replies |
| Transfer | Tier preview for any transfer without the LLM, then submit to the executor |
| Activity | The full audit trail with filters, explorer links and the hash-chain badge |
| Security | Tier explanations, limits per asset, allow/deny lists, the role matrix, vault status |
| Settings | Light, dark or system theme, a voice test, account details, and owner-only team management |

Navigation is a sidebar on desktop and a slide-in drawer on phones. Pages
animate in and out, and every page sets its own tab title. Animations respect
the system's reduced-motion setting.

## Roles

| Role | Can |
|---|---|
| viewer | read balances, policy, budgets and the audit trail |
| operator | viewer, plus preview, submit transfers and chat with the agent |
| owner | operator, plus approve or reject T2 and pause the wallet |

The server checks the role on every request (`src/auth/rbac.ts`). Hiding
buttons in the UI is only a convenience. No role can resume the wallet or
change limits; only an owner can add or remove accounts (Settings → Team),
and that first-run setup window exists only while zero accounts do. The agent's
LLM has no tool that can touch accounts, roles or the kill switch.

## Voice

The microphone button uses the browser's own speech recognition (Chrome and
Edge work best), and replies can be read aloud with the browser's speech
synthesis. No audio reaches the wallet server. Voice only types into the chat:
approving a T2 always needs an owner's click.

## How approvals work

T2 transactions park in a shared `WebApprover` queue on the server. The
approval dialog polls `GET /api/pending` and an owner answers with
`POST /api/decide`. A rejected approval resolves the executor with
`rejected_by_human` and nothing is signed (see `test/approver.test.ts`). A
request nobody answers within two minutes is rejected the same way. Each
decision is logged with the owner's name.

## Security notes

- The server binds **127.0.0.1 only**. It is a local demo, not hardened for
  hosting: never expose it beyond your machine.
- Passwords are stored as salted scrypt hashes in git-ignored `data/users.json`.
  Sessions use an HttpOnly, SameSite=Strict cookie and last 8 hours. Five
  failed sign-ins for a name lock it for 15 minutes.
- The server refuses a `Host` or `Origin` that is not loopback, and any POST
  that is not `application/json`. Another website open in the same browser
  therefore cannot approve a T2 or send a transaction.
- Every state change still passes through the policy engine and the executor,
  exactly as in the CLI.
