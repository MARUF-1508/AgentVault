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
