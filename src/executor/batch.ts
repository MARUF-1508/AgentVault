import { z } from 'zod';
import { resolveRecipient } from '../agent/resolve.js';
import { ActionIntentSchema, type Intent, type Policy } from '../policy/types.js';
import { MAX_BATCH } from './executor.js';

const Line = z.object({
  to: z.string().min(1).max(100),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'decimal string'),
  token: z.string().max(20).optional(),
});

/**
 * Validates a batch of transfers (T3) from untrusted input (a file, the web UI
 * or the model). A recipient may be a 0x address or a saved name; names are
 * resolved against the allowlist only, never guessed. Returns intents for
 * `Executor.executeBatch`, or the first problem found.
 */
export function parseBatch(raw: unknown, policy: Policy): { intents: Intent[] } | { error: string } {
  const parsed = z.array(Line).min(1).max(MAX_BATCH).safeParse(raw);
  if (!parsed.success) return { error: `A batch is 1-${MAX_BATCH} lines of { to, amount, token? }: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const intents: Intent[] = [];
  for (const [i, line] of parsed.data.entries()) {
    const r = resolveRecipient(policy, line.to);
    if (!r.found || !r.address) return { error: `Line ${i + 1}: no saved recipient called "${line.to}". Use a 0x address.` };
    const candidate = line.token
      ? { kind: 'erc20_transfer', token: line.token, to: r.address, amount: line.amount }
      : { kind: 'native_transfer', to: r.address, amount: line.amount };
    const intent = ActionIntentSchema.safeParse(candidate);
    if (!intent.success) return { error: `Line ${i + 1}: ${intent.error.issues[0]?.message ?? 'invalid transfer'}` };
    intents.push(intent.data);
  }
  return { intents };
}
