import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { PolicySchema, type Policy } from './policy/types.js';

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
  SCHEDULES_FILE: z.string().default('config/schedules.json'),
  AUDIT_LOG: z.string().default('data/audit.jsonl'),
  PAUSE_FILE: z.string().default('data/PAUSED'),
  ALLOW_MAINNET: z.string().default('false'),
  // Executor vault-routing mode (VAULT=true sends native transfers via agentSend).
  VAULT: z.string().default('false'),
  // Deployed AgentVault and its externally-observed txs, for the evidence doc.
  VAULT_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'VAULT_ADDRESS must be a 0x-prefixed address')
    .optional(),
  VAULT_DEPLOY_TX: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'VAULT_DEPLOY_TX must be a 0x-prefixed tx hash')
    .optional(),
  VAULT_SET_RECIPIENT_TX: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'VAULT_SET_RECIPIENT_TX must be a 0x-prefixed tx hash')
    .optional(),
  VAULT_SEND_TX: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'VAULT_SEND_TX must be a 0x-prefixed tx hash')
    .optional(),
  VAULT_REVERT_TX: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'VAULT_REVERT_TX must be a 0x-prefixed tx hash')
    .optional(),
  VAULT_DENY_TX: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'VAULT_DENY_TX must be a 0x-prefixed tx hash')
    .optional(),
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
  return parsed.data;
}

export function loadPolicy(path: string): Policy {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return PolicySchema.parse(raw);
}
