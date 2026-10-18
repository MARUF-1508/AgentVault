import { erc20Abi, formatEther, formatUnits, parseUnits } from 'viem';
import type { AuditLog } from '../audit/log.js';
import type { Clients } from '../chain/client.js';
import { quoteExactInputSingle } from '../dex/uniswap.js';
import type { Executor } from '../executor/executor.js';
import { tokenInfo } from '../policy/engine.js';
import { ActionIntentSchema, SwapIntentSchema, type Policy } from '../policy/types.js';
import { getPortfolio } from '../portfolio/portfolio.js';
import { resolveRecipient } from './resolve.js';
import type { Schedules } from '../schedule/rules.js';
import { fetchPaidData } from '../x402.js';

const actionParams = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['native_transfer', 'erc20_transfer', 'erc20_approve'] },
    to: { type: 'string', description: 'Recipient address (transfers only)' },
    spender: { type: 'string', description: 'Spender contract address (approve only)' },
    token: { type: 'string', description: 'Token symbol from the policy, e.g. USDC (erc20 only)' },
    amount: { type: 'string', description: 'Human-readable decimal amount, e.g. "0.0001". "unlimited" only for approve. For approve, amount "0" revokes a stale allowance.' },
  },
  required: ['kind'],
  additionalProperties: false,
} as const;

const swapParams = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['swap'] },
    tokenIn: { type: 'string', description: 'Token symbol to sell, from the policy' },
    tokenOut: { type: 'string', description: 'Token symbol to buy, from the policy' },
    amountIn: { type: 'string', description: 'Human-readable decimal amount of tokenIn to sell' },
    slippageBps: { type: 'number', description: 'Max slippage in basis points; must not exceed the policy cap' },
    router: { type: 'string', description: 'Optional; must equal the policy router if given' },
  },
  required: ['kind', 'tokenIn', 'tokenOut', 'amountIn', 'slippageBps'],
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
      name: 'get_portfolio',
      description: 'T0 read-only. Every asset balance with a USD value and total, for asset-management questions like "what do I have?".',
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
      name: 'get_swap_quote',
      description: 'T0 read-only. Quote a swap (tokenIn, tokenOut, amountIn) on the policy DEX and show the expected output and minimum output at a slippage cap.',
      parameters: {
        type: 'object',
        properties: {
          tokenIn: { type: 'string' },
          tokenOut: { type: 'string' },
          amountIn: { type: 'string' },
          slippageBps: { type: 'number', description: 'Optional; defaults to the policy auto slippage cap.' },
        },
        required: ['tokenIn', 'tokenOut', 'amountIn'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'resolve_recipient',
      description:
        'T0 read-only. Look up a recipient name (or address) in the saved allowlist and denylist before any transfer. If the name is not found, do NOT guess an address — ask the user for the 0x address.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'A name like "alice", or a 0x address' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'preview_transaction',
      description: 'Ask the policy engine which tier a transfer or approval would fall into (T1 auto, T2 needs human, T3 denied) without executing it.',
      parameters: actionParams,
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'execute_transaction',
      description: 'Execute a transfer or approval. It is checked by the policy engine, simulated, and may require human approval. Returns the tx hash on success. For swaps use execute_swap instead.',
      parameters: actionParams,
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'execute_swap',
      description: 'Swap one policy token for another via the allowlisted DEX. A bounded approval is sent first only if needed, then the swap. Both steps are policy-checked and may need approval.',
      parameters: swapParams,
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
  {
    type: 'function' as const,
    function: {
      name: 'list_schedules',
      description: 'T0 read-only. The user-configured scheduled and conditional rules. You cannot add or change them.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fetch_paid_data',
      description:
        'Fetch a resource from the configured paid API (x402 style). If it answers 402 Payment Required, the advertised price is paid through the policy engine (the tier rules apply) and the request is retried once. Use it for data that costs a small testnet fee.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the resource; its origin must match the configured paid API.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'what_if',
      description:
        'T0 read-only. Answers "what would happen if ...?": returns the policy verdict for a transfer as things stand today beside the verdict under a hypothesis (the recipient were already allowlisted, the limits were different, the wallet were paused). Nothing is sent and nothing changes.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['native_transfer', 'erc20_transfer'] },
          to: { type: 'string', description: 'Recipient address' },
          amount: { type: 'string', description: 'Human-readable decimal amount, e.g. "0.0005"' },
          token: { type: 'string', description: 'Token symbol from the policy (erc20 only)' },
          allowRecipient: { type: 'boolean', description: 'Assume this recipient is already allowlisted' },
          autoMaxPerTx: { type: 'string', description: 'Assume this auto limit for the asset' },
          hardMaxPerTx: { type: 'string', description: 'Assume this hard cap for the asset' },
          dailyBudget: { type: 'string', description: 'Assume this daily budget for the asset' },
          paused: { type: 'boolean', description: 'Assume the kill switch is on' },
        },
        required: ['kind', 'to', 'amount'],
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
  /** Optional: user-configured schedules, exposed read-only to the agent. */
  schedules?: Schedules;
  /** Optional: the only origin fetch_paid_data may call (from X402_API_URL). */
  x402ApiUrl?: string;
}

/** Runs a tool call. Every argument from the model is validated; nothing is trusted. */
export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<unknown> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = rawArgs ? JSON.parse(rawArgs) : {};
    // The model's arguments are untrusted: only a plain JSON object is meaningful.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'Arguments must be a JSON object.' };
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return { error: 'Arguments were not valid JSON.' };
  }
  try {
    return await dispatchTool(name, args, ctx);
  } catch (err) {
    // A failing read or integration must reach the model as data, never crash the turn.
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Validated tool dispatch, split out so an unexpected failure is returned, not thrown. */
async function dispatchTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const { publicClient, account, chain } = ctx.clients;

  switch (name) {
    case 'get_wallet_info': {
      if (!account) return { error: 'No wallet key configured (read-only mode).' };
      const bal = await publicClient.getBalance({ address: account.address });
      return { address: account.address, chain: chain.name, chainId: chain.id, balance: `${formatEther(bal)} ${ctx.policy.native.symbol}` };
    }
    case 'get_portfolio':
      return getPortfolio(ctx.clients, ctx.policy);
    case 'get_token_balance': {
      const t = tokenInfo(ctx.policy, String(args.token ?? ''));
      if (!t) return { error: `Token ${args.token ?? '(none)'} is not in the policy.` };
      if (!account) return { error: 'No wallet key configured.' };
      const bal = await publicClient.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
      return { token: t.symbol, balance: formatUnits(bal, t.decimals) };
    }
    case 'get_policy':
      return ctx.policy;
    case 'get_swap_quote':
      return swapQuote(args, ctx);
    case 'resolve_recipient':
      return resolveRecipient(ctx.policy, String(args.name ?? ''));
    case 'preview_transaction':
    case 'execute_transaction': {
      const parsed = ActionIntentSchema.safeParse(args);
      if (!parsed.success) return { error: 'Invalid transaction', issues: parsed.error.issues.map((i) => i.message) };
      if (name === 'preview_transaction') {
        const d = await ctx.executor.preview(parsed.data);
        return { tier: d.tier, reasons: d.reasons };
      }
      return executionSummary(await ctx.executor.execute(parsed.data));
    }
    case 'execute_swap':
      return executeSwap(args, ctx);
    case 'what_if': {
      const intent =
        args.kind === 'erc20_transfer'
          ? { kind: 'erc20_transfer' as const, token: args.token, to: args.to, amount: args.amount }
          : { kind: 'native_transfer' as const, to: args.to, amount: args.amount };
      const parsed = ActionIntentSchema.safeParse(intent);
      if (!parsed.success) return { error: 'Invalid transaction', issues: parsed.error.issues.map((i) => i.message) };
      const recipient = parsed.data.kind === 'erc20_approve' ? parsed.data.spender : parsed.data.to;
      const limits: { autoMaxPerTx?: string; hardMaxPerTx?: string; dailyBudget?: string } = {};
      for (const key of ['autoMaxPerTx', 'hardMaxPerTx', 'dailyBudget'] as const) {
        if (typeof args[key] === 'string') limits[key] = args[key];
      }
      const r = await ctx.executor.whatIf(parsed.data, {
        ...(args.allowRecipient === true ? { allowRecipients: [recipient] } : {}),
        ...(args.paused === true ? { paused: true } : {}),
        ...(Object.keys(limits).length > 0 ? { limits } : {}),
      });
      return {
        today: { tier: r.baseline.tier, reasons: r.baseline.reasons },
        underHypothesis: { tier: r.hypothetical.tier, reasons: r.hypothetical.reasons },
        morePermissive: r.morePermissive,
        summary: r.summary,
      };
    }
    case 'get_recent_activity': {
      const limit = clampLimit(args.limit);
      return ctx.audit.read().slice(-limit).map(({ seq, ts, type, data }) => ({ seq, ts, type, data }));
    }
    case 'list_schedules':
      return ctx.schedules ?? { version: 1, rules: [] };
    case 'fetch_paid_data': {
      if (!ctx.x402ApiUrl) return { error: 'The paid API is not configured (set X402_API_URL).' };
      const url = String(args.url ?? '');
      const chain = ctx.clients.chain;
      return fetchPaidData(url, new URL(ctx.x402ApiUrl).origin, {
        fetchFn: fetch,
        execute: (intent) => ctx.executor.execute(intent),
        network: chain.name,
        caip2: `eip155:${chain.id}`,
        from: ctx.clients.account?.address,
        symbol: ctx.policy.native.symbol,
      });
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

function executionSummary(r: Awaited<ReturnType<Executor['execute']>>) {
  return { status: r.status, tier: r.decision.tier, reasons: r.decision.reasons, txHash: r.txHash, explorerUrl: r.explorerUrl, error: r.error };
}

/** A safe page size from untrusted model input: an integer in [1, max], else the default. */
function clampLimit(value: unknown, def = 10, max = 50): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

async function swapQuote(args: Record<string, unknown>, ctx: ToolContext) {
  const swap = ctx.policy.swap;
  if (!swap) return { error: 'Swaps are not enabled in the policy.' };
  const tokenIn = tokenInfo(ctx.policy, String(args.tokenIn ?? ''));
  const tokenOut = tokenInfo(ctx.policy, String(args.tokenOut ?? ''));
  if (!tokenIn || !tokenOut) return { error: 'tokenIn or tokenOut is not in the policy.' };
  const amountIn = String(args.amountIn ?? '');
  // Informational only, but never show a minimum past the policy's hard slippage cap.
  const requested = args.slippageBps === undefined ? swap.autoMaxSlippageBps : Number(args.slippageBps);
  const slippageBps = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 0), swap.maxSlippageBps)
    : swap.autoMaxSlippageBps;
  try {
    const amountOut = await quoteExactInputSingle(ctx.clients.publicClient, swap.quoter, {
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn: parseUnits(amountIn, tokenIn.decimals),
      fee: swap.feeTier,
    });
    const minOut = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    return {
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn,
      amountOut: formatUnits(amountOut, tokenOut.decimals),
      slippageBps,
      minAmountOut: formatUnits(minOut, tokenOut.decimals),
      router: swap.router,
      note: 'Quote is read-only. Use execute_swap to run it; the policy engine sets the on-chain minimum.',
    };
  } catch (err) {
    return { error: `Could not quote the swap: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Swap orchestration: a bounded approval (only if the current allowance is short),
 * then the swap. Each step goes through Executor.execute, so each is policy-checked
 * and logged separately. The approval is exactly amountIn, never unlimited.
 */
async function executeSwap(args: Record<string, unknown>, ctx: ToolContext) {
  const parsed = SwapIntentSchema.safeParse(args);
  if (!parsed.success) {
    return { error: 'Invalid swap', issues: parsed.error.issues.map((i) => i.message) };
  }
  const intent = parsed.data;
  const tokenIn = tokenInfo(ctx.policy, intent.tokenIn);
  const router = ctx.policy.swap?.router;
  const owner = ctx.clients.account?.address;
  if (!tokenIn || !router || !owner) return { error: 'Swap is not available (no policy router or no wallet key).' };

  const steps: unknown[] = [];

  // Validate the whole swap first. A denied swap must not broadcast an approval,
  // which would waste gas and leave a standing allowance behind.
  const preview = await ctx.executor.preview(intent);
  if (preview.tier === 'T3_DENY') {
    return { steps, tier: preview.tier, reasons: preview.reasons, error: 'Swap denied by policy; no approval was sent.' };
  }

  let amountInBase: bigint;
  try {
    amountInBase = parseUnits(intent.amountIn, tokenIn.decimals);
  } catch (err) {
    return { error: err instanceof Error ? err.message : `Invalid amount ${intent.amountIn}` };
  }
  const allowance = await ctx.clients.publicClient.readContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, router],
  });
  if (allowance < amountInBase) {
    const approve = await ctx.executor.execute({ kind: 'erc20_approve', token: intent.tokenIn, spender: router, amount: intent.amountIn });
    steps.push({ step: 'approve', ...executionSummary(approve) });
    if (approve.status !== 'executed') return { steps, error: 'Approval step did not execute; swap not attempted.' };
  } else {
    steps.push({ step: 'approve', status: 'skipped', reason: 'Existing allowance is sufficient.' });
  }

  const swap = await ctx.executor.execute(intent);
  steps.push({ step: 'swap', ...executionSummary(swap) });
  return { steps };
}
