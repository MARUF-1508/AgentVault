import { erc20Abi, formatEther, formatUnits } from 'viem';
import type { AuditLog } from '../audit/log.js';
import type { Clients } from '../chain/client.js';
import type { Executor } from '../executor/executor.js';
import { tokenInfo } from '../policy/engine.js';
import { IntentSchema, type Policy } from '../policy/types.js';

const intentParams = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['native_transfer', 'erc20_transfer', 'erc20_approve'] },
    to: { type: 'string', description: 'Recipient address (transfers only)' },
    spender: { type: 'string', description: 'Spender contract address (approve only)' },
    token: { type: 'string', description: 'Token symbol from the policy, e.g. USDC (erc20 only)' },
    amount: { type: 'string', description: 'Human-readable decimal amount, e.g. "0.0001". "unlimited" only for approve.' },
  },
  required: ['kind', 'amount'],
  additionalProperties: false,
} as const;

/** OpenAI-compatible tool definitions. Read-only tools are tier T0. */
export const toolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'get_wallet_info',
      description: 'T0 read-only. Wallet address, chain, and native balance.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_token_balance',
      description: 'T0 read-only. Balance of a token listed in the policy.',
      parameters: {
        type: 'object',
        properties: { token: { type: 'string' } },
        required: ['token'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_policy',
      description: 'T0 read-only. The spending policy: per-tx limits, daily budgets, allowlists. Read it before planning a transaction.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'preview_transaction',
      description: 'Ask the policy engine which tier a transaction would fall into (T1 auto, T2 needs human, T3 denied) without executing it.',
      parameters: intentParams,
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'execute_transaction',
      description: 'Execute a transaction. It is checked by the policy engine, simulated, and may require human approval. Returns the tx hash on success.',
      parameters: intentParams,
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_recent_activity',
      description: 'T0 read-only. Recent audit-log entries (intents, decisions, tx hashes).',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number' } },
        additionalProperties: false,
      },
    },
  },
];

export interface ToolContext {
  clients: Clients;
  policy: Policy;
  executor: Executor;
  audit: AuditLog;
}

/** Runs a tool call. Every argument from the model is validated; nothing is trusted. */
export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<unknown> {
  let args: Record<string, unknown>;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { error: 'Arguments were not valid JSON.' };
  }
  const { publicClient, account, chain } = ctx.clients;

  switch (name) {
    case 'get_wallet_info': {
      if (!account) return { error: 'No wallet key configured (read-only mode).' };
      const bal = await publicClient.getBalance({ address: account.address });
      return { address: account.address, chain: chain.name, chainId: chain.id, balance: `${formatEther(bal)} ${ctx.policy.native.symbol}` };
    }
    case 'get_token_balance': {
      const t = tokenInfo(ctx.policy, String(args.token ?? ''));
      if (!t) return { error: `Token ${args.token} is not in the policy.` };
      if (!account) return { error: 'No wallet key configured.' };
      const bal = await publicClient.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
      return { token: t.symbol, balance: formatUnits(bal, t.decimals) };
    }
    case 'get_policy':
      return ctx.policy;
    case 'preview_transaction':
    case 'execute_transaction': {
      const parsed = IntentSchema.safeParse(args);
      if (!parsed.success) return { error: 'Invalid transaction', issues: parsed.error.issues.map((i) => i.message) };
      if (name === 'preview_transaction') {
        const d = ctx.executor.preview(parsed.data);
        return { tier: d.tier, reasons: d.reasons };
      }
      const r = await ctx.executor.execute(parsed.data);
      return { status: r.status, tier: r.decision.tier, reasons: r.decision.reasons, txHash: r.txHash, explorerUrl: r.explorerUrl, error: r.error };
    }
    case 'get_recent_activity': {
      const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 50);
      return ctx.audit.read().slice(-limit).map(({ seq, ts, type, data }) => ({ seq, ts, type, data }));
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}
