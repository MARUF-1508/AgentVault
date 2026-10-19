import { describe, expect, it } from 'vitest';
import type { Approver } from '../src/approval/approver.js';
import { parseBatch } from '../src/executor/batch.js';
import { ALICE, BOB, basePolicy, harness } from './helpers.js';

const policy = basePolicy();

describe('batch payments (T3)', () => {
  it('parses names and addresses, and never guesses an unknown name', () => {
    const ok = parseBatch([{ to: 'alice', amount: '0.0001' }, { to: BOB, amount: '0.0002' }], policy);
    expect(ok).toMatchObject({ intents: [{ kind: 'native_transfer', to: ALICE }, { to: BOB }] });
    expect(parseBatch([{ to: 'carol', amount: '1' }], policy)).toEqual({ error: expect.stringMatching(/no saved recipient called "carol"/) });
    expect(parseBatch([], policy)).toHaveProperty('error');
    expect(parseBatch(Array.from({ length: 11 }, () => ({ to: 'alice', amount: '0.0001' })), policy)).toHaveProperty('error');
    expect(parseBatch([{ to: 'alice', amount: '-1' }], policy)).toHaveProperty('error');
  });

  it('counts earlier lines toward later ones, so a batch cannot split its way past the budget', async () => {
    const { executor } = harness();
    // Each line is within the hard cap (0.005); together they exceed the 0.01 daily budget.
    const lines = parseBatch(
      [
        { to: 'alice', amount: '0.004' },
        { to: 'alice', amount: '0.004' },
        { to: 'alice', amount: '0.004' },
      ],
      policy,
    );
    if ('error' in lines) throw new Error(lines.error);
    const preview = await executor.previewBatch(lines.intents);
    expect(preview.map((l) => l.decision.tier)).toEqual(['T2_CONFIRM', 'T2_CONFIRM', 'T3_DENY']);
    expect(preview[2]!.decision.reasons[0]).toMatch(/Daily budget exceeded/);
  });

  it('sends nothing when any line would be refused', async () => {
    const { executor, sent } = harness();
    const lines = parseBatch([{ to: 'alice', amount: '0.0001' }, { to: 'alice', amount: '1' }], policy);
    if ('error' in lines) throw new Error(lines.error);
    const r = await executor.executeBatch(lines.intents);
    expect(r.results).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('executes every line when all pass, each through the executor', async () => {
    const { executor, sent, audit } = harness();
    const lines = parseBatch([{ to: 'alice', amount: '0.0001' }, { to: 'alice', amount: '0.0002' }], policy);
    if ('error' in lines) throw new Error(lines.error);
    const r = await executor.executeBatch(lines.intents);
    expect(r.results.map((x) => x.status)).toEqual(['executed', 'executed']);
    expect(sent).toHaveLength(2);
    expect(audit.read().filter((e) => e.type === 'decision')).toHaveLength(2);
  });
});

describe('transaction status (T4)', () => {
  it('reports pending when the receipt does not arrive in time, and it still counts to the budget', async () => {
    const { executor, audit } = harness({
      receipt: async () => {
        throw new Error('Timed out while waiting for transaction');
      },
    });
    const r = await executor.execute({ kind: 'native_transfer', to: ALICE, amount: '0.0001' });
    expect(r.status).toBe('pending');
    expect(r.txHash).toMatch(/^0x/);
    expect(audit.read().map((e) => e.type)).toContain('tx_pending');
    expect(executor.pendingTxs()).toHaveLength(1);
    const status = await executor.txStatus(r.txHash!);
    expect(status.status).toBe('pending');
  });

  it('picks up a late receipt from the chain and writes it to the audit log', async () => {
    let mined = false;
    const { executor, audit } = harness({
      receipt: async () => {
        throw new Error('timeout');
      },
      getTransactionReceipt: async () => {
        if (!mined) throw new Error('not found');
        return { status: 'success', blockNumber: 100n, gasUsed: 21000n };
      },
    });
    const r = await executor.execute({ kind: 'native_transfer', to: ALICE, amount: '0.0001' });
    expect((await executor.txStatus(r.txHash!)).status).toBe('pending');
    mined = true;
    const status = await executor.txStatus(r.txHash!);
    expect(status).toMatchObject({ status: 'confirmed', blockNumber: '100', confirmations: 6 });
    expect(audit.read().filter((e) => e.type === 'tx_confirmed')).toHaveLength(1);
    expect(executor.pendingTxs()).toHaveLength(0);
    // Asking again does not log a second confirmation.
    await executor.txStatus(r.txHash!);
    expect(audit.read().filter((e) => e.type === 'tx_confirmed')).toHaveLength(1);
  });

  it('says unknown for a hash this wallet never sent', async () => {
    const { executor } = harness();
    expect((await executor.txStatus(`0x${'f'.repeat(64)}`)).status).toBe('unknown');
  });
});

describe('reservations while a receipt is outstanding', () => {
  it('counts a broadcast spend once, not twice, so a parallel request is not falsely refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { executor } = harness({
      approver: { confirm: async () => true },
      receipt: async () => {
        await gate;
        return { status: 'success', blockNumber: 1n, gasUsed: 1n };
      },
    });
    // Budget 0.01. First send of 0.005 is broadcast and waits for its receipt.
    const first = executor.execute({ kind: 'native_transfer', to: ALICE, amount: '0.005' }, {});
    await new Promise((r) => setTimeout(r, 20));
    // 0.005 already broadcast + 0.005 = exactly the budget: must be allowed.
    const preview = await executor.preview({ kind: 'native_transfer', to: ALICE, amount: '0.005' });
    expect(preview.tier).not.toBe('T3_DENY');
    release();
    expect((await first).status).toBe('executed');
  });
});

describe('approval card shows the decoded call (S6)', () => {
  it('decodes the exact calldata that will be signed', async () => {
    let summary = '';
    const approver: Approver = {
      confirm: async (s) => {
        summary = s;
        return false;
      },
    };
    const usdc = basePolicy({
      tokens: { USDC: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, autoMaxPerTx: '1', hardMaxPerTx: '10', dailyBudget: '25' } },
    });
    const { executor } = harness({ policy: usdc, approver });
    await executor.execute({ kind: 'erc20_transfer', token: 'USDC', to: BOB, amount: '2' });
    expect(summary).toContain(`Call   : ERC-20.transfer(${BOB}, 2000000) on 0x036CbD53842c5426634e7929541eC2318f3dCF7e`);
    expect(summary).toContain('Tier   : T2_CONFIRM');
  });
});
