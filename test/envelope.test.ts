import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import type { AuditEntry, AuditLog } from '../src/audit/log.js';
import { DenyAllApprover } from '../src/approval/approver.js';
import type { Clients } from '../src/chain/client.js';
import { Executor } from '../src/executor/executor.js';
import { evaluate } from '../src/policy/engine.js';
import { PolicySchema, type SpendState } from '../src/policy/types.js';

const ALICE = '0x4785Dca37A242F3D80f844CB0b143A687008a2B5';
const CHAIN_ID = 84532;

const policy = PolicySchema.parse({
  version: 1,
  chainId: CHAIN_ID,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: { USDC: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, autoMaxPerTx: '1', hardMaxPerTx: '10', dailyBudget: '25' } },
  recipients: { allowlist: { alice: ALICE }, denylist: [] },
  approvals: { allowUnlimited: false, spenderAllowlist: {} },
  rateLimit: { maxTxPerHour: 5 },
});

const fresh = (envelope?: SpendState['envelope']): SpendState => ({
  spentToday: {},
  txLastHour: 0,
  paused: false,
  ...(envelope ? { envelope } : {}),
});

describe('task envelope: the pure engine', () => {
  const intent = { kind: 'native_transfer' as const, to: ALICE as `0x${string}`, amount: '0.0005' };

  it('allows a spend that fits the task envelope', () => {
    const d = evaluate(intent, policy, fresh({ asset: 'ETH', budgetBase: parseEther('0.001'), spentBase: 0n }), CHAIN_ID);
    expect(d.tier).toBe('T1_AUTO');
  });

  it('denies a spend that would exceed the task envelope, naming the reason', () => {
    const d = evaluate(intent, policy, fresh({ asset: 'ETH', budgetBase: parseEther('0.001'), spentBase: parseEther('0.0008') }), CHAIN_ID);
    expect(d.tier).toBe('T3_DENY');
    expect(d.reasons.join(' ')).toMatch(/Task budget exceeded/);
  });

  it('an envelope for another asset never blocks this spend', () => {
    const d = evaluate(intent, policy, fresh({ asset: 'USDC', budgetBase: 0n, spentBase: 0n }), CHAIN_ID);
    expect(d.tier).toBe('T1_AUTO');
  });

  it('does not apply the envelope to approvals (only the transfer they enable spends)', () => {
    const approve = { kind: 'erc20_approve' as const, token: 'USDC', spender: ALICE as `0x${string}`, amount: '1' };
    const d = evaluate(approve, policy, fresh({ asset: 'USDC', budgetBase: 0n, spentBase: 0n }), CHAIN_ID);
    expect(d.reasons.join(' ')).not.toMatch(/Task budget/);
  });
});

function harness() {
  const sent: { to: string; value: bigint; data?: string }[] = [];
  const entries: AuditEntry[] = [];
  const audit = {
    append: (type: string, data: Record<string, unknown>) => {
      const e = { seq: entries.length + 1, ts: new Date().toISOString(), type, data, prevHash: '', hash: '' } as AuditEntry;
      entries.push(e);
      return e;
    },
    read: () => entries,
    verify: () => ({ ok: true }),
  } as unknown as AuditLog;
  const clients = {
    chain: { id: CHAIN_ID, name: 'Base Sepolia' },
    publicClient: {
      call: async () => ({}),
      estimateGas: async () => 21000n,
      getGasPrice: async () => 1n,
      waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n, gasUsed: 1n }),
    },
    walletClient: {
      sendTransaction: async (tx: { to: string; value: bigint; data?: string }) => {
        sent.push(tx);
        return '0xhash';
      },
    },
    account: { address: '0x1111111111111111111111111111111111111111' },
  } as unknown as Clients;
  return { executor: new Executor(clients, policy, audit, new DenyAllApprover(), '/nonexistent/PAUSED'), sent, entries };
}

describe('task envelope: enforced across separate executions', () => {
  const send = (amount: string) => ({ kind: 'native_transfer' as const, to: ALICE as `0x${string}`, amount });

  it("sums a task's prior spend from the audit log and denies once the cap is reached", async () => {
    const { executor, sent } = harness();
    const run = (amount: string) => executor.execute(send(amount), { task: 'buy-quote', taskMax: '0.001' });
    expect((await run('0.0005')).status).toBe('executed');
    expect((await run('0.0005')).status).toBe('executed');
    const third = await run('0.0005');
    expect(third.status).toBe('denied');
    expect(third.decision.reasons.join(' ')).toMatch(/Task budget exceeded/);
    expect(sent).toHaveLength(2); // the third was never broadcast
  });

  it("another task is unaffected by a first task's spend", async () => {
    const { executor, sent } = harness();
    await executor.execute(send('0.0009'), { task: 'a', taskMax: '0.001' });
    const other = await executor.execute(send('0.0009'), { task: 'b', taskMax: '0.001' });
    expect(other.status).toBe('executed');
    expect(sent).toHaveLength(2);
  });

  it('without a taskMax the task is unbounded (the daily budget still applies)', async () => {
    const { executor } = harness();
    expect((await executor.execute(send('0.0005'), { task: 'x' })).status).toBe('executed');
  });

  it("a task's own failed (reverted) transaction still counts against its envelope", async () => {
    const sent: { to: string; value: bigint; data?: string }[] = [];
    const entries: AuditEntry[] = [];
    const audit = {
      append: (type: string, data: Record<string, unknown>) => {
        const e = { seq: entries.length + 1, ts: new Date().toISOString(), type, data, prevHash: '', hash: '' } as AuditEntry;
        entries.push(e);
        return e;
      },
      read: () => entries,
      verify: () => ({ ok: true }),
    } as unknown as AuditLog;
    const clients = {
      chain: { id: CHAIN_ID, name: 'Base Sepolia' },
      publicClient: {
        call: async () => ({}),
        estimateGas: async () => 21000n,
        getGasPrice: async () => 1n,
        waitForTransactionReceipt: async () => ({ status: 'reverted', blockNumber: 1n, gasUsed: 1n }),
      },
      walletClient: {
        sendTransaction: async (tx: { to: string; value: bigint; data?: string }) => {
          sent.push(tx);
          return '0xhash';
        },
      },
      account: { address: '0x1111111111111111111111111111111111111111' },
    } as unknown as Clients;
    const executor = new Executor(clients, policy, audit, new DenyAllApprover(), '/nonexistent/PAUSED');

    expect((await executor.execute(send('0.0006'), { task: 't', taskMax: '0.001' })).status).toBe('reverted');
    const next = await executor.execute(send('0.0006'), { task: 't', taskMax: '0.001' });
    expect(next.status).toBe('denied');
    expect(sent).toHaveLength(1);
  });
});
