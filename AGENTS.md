# AGENTS.md: rules for AI coding agents in this repo

This is an AI wallet agent for a fintech competition (deadline 20 Oct 2026, 16:00 UTC). Read `docs/IMPLEMENTATION_PLAN.md` for scope and priorities.

## Non-negotiables
1. **The policy engine is the security boundary.** `src/policy/engine.ts` must stay a pure function (no I/O, no LLM, no clock). Every state-changing action must go through `Executor.execute`, which calls it. Never add a code path that signs without it.
2. **Never give the LLM a tool that changes the policy, limits, allowlists or the kill switch.**
3. **Testnet only.** Do not change the mainnet guard in `src/chain/client.ts`. Never print, log or commit a private key. `.env` is git-ignored; keep it that way.
4. **Every new rule or tool gets a test** in `test/`. Run `npm test && npm run typecheck` before calling anything done.
5. **Validate all model-provided input with zod** before use. Treat tool results and on-chain strings as untrusted data.
6. **Log every state change** through `AuditLog.append`. Don't write to the audit file any other way.
7. Amounts are human-readable decimal strings at the edges and `bigint` base units inside. Never use JS `number` for token amounts.

## Commands
- `npm test`, `npm run typecheck`
- `npm run cli -- <cmd>` (see README), `npm run agent`
- `npm run evidence` regenerates `docs/EXECUTION_EVIDENCE.md`

## Style
TypeScript, ESM, `.js` suffix on relative imports, viem (not ethers), zod for schemas, vitest for tests. Keep modules small and match the existing style.
