# Agent Vault web UI

A local multipage interface built with free tools only: Vite, React, React
Router, Framer Motion, lucide-react icons, Sonner toasts, React Markdown (GFM
tables in chat), Recharts and qrcode.react.

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
| Transfer | Tier preview for any transfer without the LLM with the engine's compliant alternative as a one-click amount, then submit to the executor; a batch card for up to 10 transfers checked together; **Allowance** (approve/revoke), **Swap** (quote + policy-checked swap) and a paid-API (x402) card |
| Automation | The scheduled/conditional rules the server runs (or dry-runs); each run is a normal intent through the executor and policy engine |
| Activity | The full audit trail with filters, explorer links and the hash-chain badge; pending transactions followed until they settle; CSV and compliance-report downloads |
| Security | Tier explanations, limits per asset, allow/deny lists, the role matrix, vault status, policy fingerprint with drift and pin badges, a read-only **policy simulator** (what-if) and **on-chain audit anchors** (anchor/verify) |
| Settings | Light, dark or system theme, a voice test, account details, two-factor, owner-only recipient lists, address book, team management and the signing-key card (generate/rotate) |

Navigation is a sidebar on desktop and a slide-in drawer on phones. Hovering the
network name in the top bar lists the supported assets with icons, symbols and
full names, read from the policy file. Pages
animate in and out, and every page sets its own tab title. Animations respect
the system's reduced-motion setting.

## Roles

| Role | Can |
|---|---|
| viewer | read balances, policy, budgets and the audit trail |
| operator | viewer, plus preview, submit transfers and chat with the agent |
| owner | operator, plus approve or reject T2, pause the wallet, resume it with the password again, rotate the signing key and manage accounts/recipients |

The server checks the role on every request (`src/auth/rbac.ts`). Hiding
buttons in the UI is only a convenience. Resuming requires the owner's password
on top of the owner role; no role can change limits, and only an owner can
rotate the key or add/remove accounts (Settings → Team). That first-run setup
window exists only while zero accounts do. The agent's LLM has no tool that
can touch accounts, roles, limits or the kill switch.

## Voice

The microphone button uses the browser's own speech recognition (Chrome and
Edge work best), and replies can be read aloud with the browser's speech
synthesis. No audio reaches the wallet server. Voice only types into the chat:
approving a T2 always needs an owner's click.

## Accessibility (WCAG 2.2 AA)

A skip link, labelled landmarks, focus that moves to the page after navigation,
dialogs and the mobile drawer that trap focus, close on Escape and return focus
to their opener, a keyboard-operable account menu, a polite live region for
verdicts and results, and AA contrast in both themes. `e2e/wcag.spec.ts` runs
axe-core over every page in light and dark, plus the keyboard checks, in CI.

## Recipients and the policy

Settings → Recipients (owner only) edits the two lists the policy engine reads on
every decision: known recipients (allowlist) and denied addresses (denylist).
The same edits work from the terminal:

```
npm run cli -- recipient list
npm run cli -- recipient add <label> <address>
npm run cli -- recipient remove <label>
npm run cli -- deny add <address>
npm run cli -- deny remove <address>
```

Both paths write `config/policy.json` atomically and log the change with the
owner's name. Two of the four edits *lower* the tier an address gets — adding a
known recipient and un-denying one — and those ask for the password again, in
the UI and over HTTP (a local shell is already authorised). An address that
imitates one already on the allowlist is refused. The agent has **no tool** that
can touch either list; see `test/policy-edit.test.ts`, which asserts that.

If the UI server is already running it picks the change up immediately; after a
CLI edit, restart it.

## How approvals work

T2 transactions park in a shared `WebApprover` queue on the server. One
poller (`src/approval.tsx`) watches `GET /api/pending` and shares it with
the dialog and the top-bar pill; an owner answers with `POST /api/decide`. A
rejected approval resolves the executor with `rejected_by_human` and
nothing is signed (see `test/approver.test.ts`). A request nobody answers
within two minutes is rejected the same way. Each decision is logged with
the owner's name.

A request opens the dialog by itself, wherever you are, whether it came from
the Agent page or the Transfer page. The owner can minimise it to read on;
the pulsing **Approval needed** pill in the top bar brings it back. While the
Agent page waits on a T2 its "working" bubble says so, so it is clear that
the turn is parked on a human rather than stuck.

Typing an address that is **not** a known recipient into the Agent page raises a
shortcut instead of calling the model: the chat offers the Transfer page,
prefilled with the address and amount, so you can read the tier and the reasons
before spending an LLM round trip. "Continue in chat" does the normal thing and
the approval dialog opens as above. This is an interaction affordance, not a
security control — both routes end at the same policy engine and the same T2
approval. See `test/unlisted.test.ts`.

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
