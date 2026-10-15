import { describe, expect, it } from 'vitest';
import { decodeFunctionData, parseUnits } from 'viem';
import { runTool, type ToolContext } from '../src/agent/tools.js';
import type { Clients } from '../src/chain/client.js';
import { encodeSwapCalldata, quoteExactInputSingle, SWAP_ROUTER_02_ABI } from '../src/dex/uniswap.js';
import type { ExecutionResult } from '../src/executor/executor.js';
import { PolicySchema, type Decision, type Intent } from '../src/policy/types.js';

const ROUTER = '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4';
const QUOTER = '0xC5290058841028F1614F3A6F0F5816cAd0df5E27';
const OWNER = '0x4785Dca37A242F3D80f844CB0b143A687008a2B5';

const policy = PolicySchema.parse({
  version: 1,
  chainId: 84532,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: {
    USDC: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, autoMaxPerTx: '1', hardMaxPerTx: '10', dailyBudget: '25' },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  },
  recipients: { allowlist: {}, denylist: [] },
  approvals: { allowUnlimited: false, spenderAllowlist: { router: ROUTER } },
  swap: { router: ROUTER, quoter: QUOTER, feeTier: 3000, maxSlippageBps: 100, autoMaxSlippageBps: 50 },
  prices: {},
  rateLimit: { maxTxPerHour: 5 },
});

const QUOTED_OUT = parseUnits('0.0002', 18);

function makeCtx(allowance: bigint, executed: Intent[], previewTier: Decision['tier'] = 'T1_AUTO'): ToolContext {
  const clients = {
    publicClient: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'quoteExactInputSingle') return [QUOTED_OUT, 0n, 0, 0n];
        if (functionName === 'allowance') return allowance;
        return 0n;
      },
    },
    account: { address: OWNER },
    chain: { id: 84532, name: 'Base Sepolia' },
  } as unknown as Clients;

  const executor = {
    preview: async (): Promise<Decision> => ({
      tier: previewTier,
      reasons: previewTier === 'T3_DENY' ? ['denied by policy'] : [],
      amountBase: 0n,
      asset: 'USDC',
    }),
    execute: async (intent: Intent): Promise<ExecutionResult> => {
      executed.push(intent);
      return {
        status: 'executed',
        decision: { tier: 'T1_AUTO', reasons: ['ok'], amountBase: 0n, asset: 'USDC' },
        txHash: '0xabc',
        explorerUrl: 'https://example/tx/0xabc',
      };
    },
  } as unknown as ToolContext['executor'];

  return { clients, policy, executor, audit: { read: () => [] } as unknown as ToolContext['audit'] };
}

describe('uniswap calldata', () => {
  it('encodes exactInputSingle and round-trips the params', () => {
    const data = encodeSwapCalldata({
      tokenIn: policy.tokens.USDC!.address,
      tokenOut: policy.tokens.WETH!.address,
      fee: 3000,
      recipient: OWNER,
      amountIn: parseUnits('0.5', 6),
      amountOutMinimum: parseUnits('0.000199', 18),
    });
    const decoded = decodeFunctionData({ abi: SWAP_ROUTER_02_ABI, data });
    expect(decoded.functionName).toBe('exactInputSingle');
    const p = decoded.args[0] as { amountIn: bigint; amountOutMinimum: bigint; recipient: string; fee: number };
    expect(p.amountIn).toBe(parseUnits('0.5', 6));
    expect(p.amountOutMinimum).toBe(parseUnits('0.000199', 18));
    expect(p.recipient.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(p.fee).toBe(3000);
  });

  it('returns the amountOut from the quoter tuple', async () => {
    const client = { readContract: async () => [QUOTED_OUT, 0n, 0, 0n] } as unknown as Parameters<typeof quoteExactInputSingle>[0];
    const out = await quoteExactInputSingle(client, QUOTER, {
      tokenIn: policy.tokens.USDC!.address,
      tokenOut: policy.tokens.WETH!.address,
      fee: 3000,
      amountIn: parseUnits('0.5', 6),
    });
    expect(out).toBe(QUOTED_OUT);
  });
});

describe('swap tools', () => {
  it('get_swap_quote returns the expected and minimum output', async () => {
    const ctx = makeCtx(0n, []);
    const r = (await runTool('get_swap_quote', JSON.stringify({ tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '0.5', slippageBps: 50 }), ctx)) as Record<string, unknown>;
    expect(r.tokenIn).toBe('USDC');
    expect(r.tokenOut).toBe('WETH');
    expect(r.amountOut).toBe('0.0002');
    expect(r.minAmountOut).toBe('0.000199');
    expect(r.router).toBe(ROUTER);
  });

  it('execute_swap sends a bounded approval first, then the swap', async () => {
    const executed: Intent[] = [];
    const ctx = makeCtx(0n, executed);
    const r = (await runTool('execute_swap', JSON.stringify({ kind: 'swap', tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '0.5', slippageBps: 50 }), ctx)) as { steps: Array<Record<string, unknown>> };

    expect(executed).toHaveLength(2);
    const approve = executed[0]!;
    expect(approve.kind).toBe('erc20_approve');
    if (approve.kind === 'erc20_approve') {
      expect(approve.amount).toBe('0.5'); // bounded to exactly the swap amount, never unlimited
      expect(approve.spender).toBe(ROUTER);
    }
    expect(executed[1]!.kind).toBe('swap');
    expect(r.steps.map((s) => s.step)).toEqual(['approve', 'swap']);
  });

  it('execute_swap skips the approval when the allowance is already sufficient', async () => {
    const executed: Intent[] = [];
    const ctx = makeCtx(parseUnits('10', 6), executed);
    await runTool('execute_swap', JSON.stringify({ kind: 'swap', tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '0.5', slippageBps: 50 }), ctx);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.kind).toBe('swap');
  });

  it('execute_swap validates the swap before sending any approval (no gas wasted)', async () => {
    const executed: Intent[] = [];
    const ctx = makeCtx(0n, executed, 'T3_DENY');
    const r = (await runTool('execute_swap', JSON.stringify({ kind: 'swap', tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '0.5', slippageBps: 900 }), ctx)) as Record<string, unknown>;

    expect(executed).toHaveLength(0); // no approval, no swap
    expect(r.tier).toBe('T3_DENY');
    expect(r.error).toBeDefined();
  });

  it('execute_swap rejects a non-swap intent', async () => {
    const ctx = makeCtx(0n, []);
    const r = (await runTool('execute_swap', JSON.stringify({ kind: 'native_transfer', to: OWNER, amount: '1' }), ctx)) as Record<string, unknown>;
    expect(r.error).toBeDefined();
  });
});
