import { describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/agent/tools.js';

// The model's tool arguments are untrusted. Malformed input must be rejected
// before it ever reaches the executor.
const ctx = {
  clients: { publicClient: {}, account: undefined, chain: { id: 84532, name: "Base Sepolia" } },
  executor: {
    preview: () => { throw new Error('should not be called'); },
    execute: () => { throw new Error('should not be called'); },
  },
} as unknown as ToolContext;

describe('tool argument validation', () => {
  it('rejects non-JSON arguments', async () => {
    expect(await runTool('execute_transaction', '{oops', ctx)).toMatchObject({ error: expect.any(String) });
  });

  it('rejects invalid addresses', async () => {
    const r = await runTool('execute_transaction', JSON.stringify({ kind: 'native_transfer', to: '0x123', amount: '1' }), ctx);
    expect(r).toMatchObject({ error: 'Invalid transaction' });
  });

  it('rejects negative or non-numeric amounts', async () => {
    const r = await runTool('execute_transaction', JSON.stringify({ kind: 'native_transfer', to: '0x1111111111111111111111111111111111111111', amount: '-1' }), ctx);
    expect(r).toMatchObject({ error: 'Invalid transaction' });
  });

  it('rejects "unlimited" outside approvals', async () => {
    const r = await runTool('execute_transaction', JSON.stringify({ kind: 'native_transfer', to: '0x1111111111111111111111111111111111111111', amount: 'unlimited' }), ctx);
    expect(r).toMatchObject({ error: 'Invalid transaction' });
  });

  it('rejects unknown tools', async () => {
    expect(await runTool('drain_wallet', '{}', ctx)).toMatchObject({ error: expect.stringMatching(/Unknown tool/) });
  });

  it('rejects a swap on the generic execute path (must use execute_swap)', async () => {
    const r = await runTool('execute_transaction', JSON.stringify({ kind: 'swap', tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '1', slippageBps: 50 }), ctx);
    expect(r).toMatchObject({ error: 'Invalid transaction' });
  });
});

describe('tool robustness', () => {
  // 60 audit entries so the 50-item cap is observable.
  const entries = Array.from({ length: 60 }, (_, i) => ({ seq: i, ts: 't', type: 'intent', data: { i } }));
  const robustCtx = { ...ctx, audit: { read: () => entries } } as unknown as ToolContext;

  it('rejects non-object arguments (null, array, scalar) instead of throwing', async () => {
    for (const raw of ['null', '[]', '5', '"hi"', 'true']) {
      expect(await runTool('execute_transaction', raw, ctx)).toMatchObject({ error: expect.any(String) });
    }
  });

  it('caps get_recent_activity at 50 entries', async () => {
    const r = (await runTool('get_recent_activity', JSON.stringify({ limit: 9999 }), robustCtx)) as unknown[];
    expect(r).toHaveLength(50);
  });

  it('sanitises a non-numeric limit rather than returning the whole log', async () => {
    const r = (await runTool('get_recent_activity', JSON.stringify({ limit: 'abc' }), robustCtx)) as unknown[];
    expect(r).toHaveLength(10); // falls back to the default page size, not 60
  });

  it('clamps a negative or zero limit to at least one entry', async () => {
    for (const limit of [-5, 0]) {
      const r = (await runTool('get_recent_activity', JSON.stringify({ limit }), robustCtx)) as unknown[];
      expect(r).toHaveLength(1);
    }
  });

  it('returns an error object (not a throw) when a chain read fails', async () => {
    const failing = {
      ...ctx,
      clients: {
        publicClient: { getBalance: async () => { throw new Error('rpc down'); } },
        account: { address: '0x4785Dca37A242F3D80f844CB0b143A687008a2B5' },
        chain: { id: 84532, name: 'Base Sepolia' },
      },
    } as unknown as ToolContext;
    await expect(runTool('get_wallet_info', '{}', failing)).resolves.toMatchObject({ error: expect.stringMatching(/rpc down/) });
  });
});
