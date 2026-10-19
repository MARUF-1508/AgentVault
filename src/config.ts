import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { registerSecret } from './audit/redact.js';
import { assertPinnedPolicy } from './policy/integrity.js';
import { PolicySchema, type Policy } from './policy/types.js';

/** A 0x-prefixed 20-byte address, for env vars that carry one. */
const EnvAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed address');
/** A 0x-prefixed 32-byte transaction hash, for the evidence env vars. */
const EnvTxHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed tx hash');

const EnvSchema = z.object({
  CHAIN: z.enum(['base-sepolia', 'sepolia']).default('base-sepolia'),
  RPC_URL: z.string().url().optional(),
  AGENT_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key')
    .optional(),
  LLM_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
  POLICY_FILE: z.string().default('config/policy.json'),
  // Optional pin of the policy file's sha256 (full hash or >= 16-char prefix).
  // When set, start-up refuses a policy file that does not match (S4).
  POLICY_SHA256: z
    .string()
    .regex(/^[0-9a-fA-F]{16,64}$/, 'POLICY_SHA256 must be 16-64 hex chars')
    .optional(),
  // Fallback RPC endpoints (comma-separated), tried in order when RPC_URL fails.
  RPC_FALLBACK_URLS: z.string().optional(),
  // Optional out-of-band approver (I4): T2 requests are also sent to this
  // Telegram chat, with Approve/Reject buttons. Both must be set to enable it.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().regex(/^-?\d+$/, 'TELEGRAM_CHAT_ID must be a numeric chat id').optional(),
  // Run enabled schedules in the background while `serve` is up (T5).
  SCHEDULER: z.string().default('false'),
  SCHEDULER_INTERVAL_SEC: z.coerce.number().int().min(15).max(3600).default(60),
  SCHEDULES_FILE: z.string().default('config/schedules.json'),
  AUDIT_LOG: z.string().default('data/audit.jsonl'),
  PAUSE_FILE: z.string().default('data/PAUSED'),
  // Web-UI accounts (scrypt hashes). Managed with `npm run cli -- user ...`.
  USERS_FILE: z.string().default('data/users.json'),
  // Base URL of the x402-style paid API the fetch_paid_data tool may call
  // (SSRF guard: requests to any other origin are refused).
  X402_API_URL: z.string().url().optional(),
  // Interface the web UI binds to. Loopback by default; set 0.0.0.0 only in a
  // container whose port is published on the host's loopback (see compose).
  WEB_HOST: z.string().default('127.0.0.1'),
  ALLOW_MAINNET: z.string().default('false'),
  // Executor vault-routing mode (VAULT=true sends native transfers via agentSend).
  VAULT: z.string().default('false'),
  // Route ERC-20 transfers through AgentVaultV2.agentSendToken as well, so the
  // vault's token cap applies on-chain. Requires VAULT=true and a V2 vault that
  // the owner has funded with the token (`setAllowedToken`).
  VAULT_TOKENS: z.string().default('false'),
  // Deployed AgentVault and its externally-observed txs, for the evidence doc.
  VAULT_ADDRESS: EnvAddress.optional(),
  VAULT_DEPLOY_TX: EnvTxHash.optional(),
  VAULT_SET_RECIPIENT_TX: EnvTxHash.optional(),
  VAULT_SEND_TX: EnvTxHash.optional(),
  VAULT_REVERT_TX: EnvTxHash.optional(),
  VAULT_DENY_TX: EnvTxHash.optional(),
  // Optional second (v2) vault: session keys + ERC-20. Rendered as its own
  // section in the evidence doc so the v1 hashes above stay as they were.
  VAULT2_ADDRESS: EnvAddress.optional(),
  VAULT2_DEPLOY_TX: EnvTxHash.optional(),
  VAULT2_GRANT_SESSION_TX: EnvTxHash.optional(),
  VAULT2_SEND_TX: EnvTxHash.optional(),
  VAULT2_REVERT_TX: EnvTxHash.optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  // Treat `KEY=` (empty) in .env as unset.
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  // Every configured secret is scrubbed from audit entries and error text (S8).
  registerSecret(parsed.data.AGENT_PRIVATE_KEY);
  registerSecret(parsed.data.LLM_API_KEY);
  registerSecret(parsed.data.TELEGRAM_BOT_TOKEN);
  return parsed.data;
}

export function loadPolicy(path: string, pinnedSha256?: string): Policy {
  // Integrity first: a pinned policy that does not match is never parsed (S4).
  assertPinnedPolicy(path, pinnedSha256);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return PolicySchema.parse(raw);
}
