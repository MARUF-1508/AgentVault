import { describe, expect, it, vi } from 'vitest';
import { DenyAllApprover, WebApprover } from '../src/approval/approver.js';
import { AuditLog } from '../src/audit/log.js';
import type { Clients } from '../src/chain/client.js';
import { Executor } from '../src/executor/executor.js';
import { PolicySchema } from '../src/policy/types.js';

const STRANGER = '0x2222222222222222222222222222222222222222';
const CHAIN_ID = 84532;

const policy = PolicySchema.parse({
  version: 1,
  chainId: CHAIN_ID,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: {},
  recipients: { allowlist: {}, denylist: [] },
  approvals: { allowUnlimited: false, spenderAllowlist: {} },
  rateLimit: { maxTxPerHour: 5 },
});

function executorWith(approver: { confirm(summary: string): Promise<boolean> }, sent: string[]) {
  const appends: { type: string; data: Record<string, unknown> }[] = [];
  const audit = {
    append: (type: string, data: Record<string, unknown>) => {
      appends.push({ type, data });
      return {} as ReturnType<AuditLog['append']>;
    },
    read: () => [],
  } as unknown as AuditLog;
  const clients = {
    chain: { id: CHAIN_ID, name: 'Base Sepolia' },
    publicClient: {
      call: async () => ({}),
      estimateGas: async () => 21000n,
      waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n, gasUsed: 1n }),
    },
    walletClient: {
      sendTransaction: async () => {
        sent.push('tx');
        return '0xhash';
      },
    },
    account: { address: '0x1111111111111111111111111111111111111111' },
  } as unknown as Clients;
  const executor = new Executor(clients, policy, audit, approver, '/nonexistent/PAUSED');
  return { executor, appends };
}

describe('rejected approvals send nothing', () => {
  it('a human "no" stops a T2 transfer before signing: no tx, no tx_sent entry', async () => {
    const sent: string[] = [];
    const { executor, appends } = executorWith(new DenyAllApprover(), sent);
    const r = await executor.execute({ kind: 'native_transfer', to: STRANGER, amount: '0.0005' });
    expect(r.status).toBe('rejected_by_human');
    expect(r.txHash).toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(appends.some((a) => a.type === 'tx_sent')).toBe(false);
    expect(appends.some((a) => a.type === 'approval' && a.data.approved === false)).toBe(true);
  });

  it('a WebApprover rejection also sends nothing', async () => {
    const sent: string[] = [];
    const approver = new WebApprover();
    const { executor, appends } = executorWith(approver, sent);
    const pending = executor.execute({ kind: 'native_transfer', to: STRANGER, amount: '0.0005' });
    await vi.waitFor(() => expect(approver.getPending()).toContain('T2_CONFIRM'));
    expect(approver.decide(false)).toBe(true);
    const r = await pending;
    expect(r.status).toBe('rejected_by_human');
    expect(sent).toHaveLength(0);
    expect(appends.some((a) => a.type === 'tx_sent')).toBe(false);
  });
});

describe('WebApprover', () => {
  it('resolves true on approve and clears the pending slot', async () => {
    const approver = new WebApprover();
    const pending = approver.confirm('summary');
    expect(approver.decide(true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(approver.getPending()).toBeNull();
  });

  it('decide with nothing pending returns false', () => {
    expect(new WebApprover().decide(true)).toBe(false);
  });

  it('a second concurrent confirm is denied rather than queued', async () => {
    const approver = new WebApprover();
    const first = approver.confirm('first');
    await expect(approver.confirm('second')).resolves.toBe(false);
    expect(approver.decide(true)).toBe(true);
    await expect(first).resolves.toBe(true);
  });

  it('an unanswered request is rejected after the timeout and the slot clears', async () => {
    vi.useFakeTimers();
    try {
      const approver = new WebApprover(1000);
      const pending = approver.confirm('summary');
      expect(approver.getPendingDetail()?.expiresAt).toBe(Date.now() + 1000);
      vi.advanceTimersByTime(1000);
      await expect(pending).resolves.toBe(false);
      expect(approver.getPendingDetail()).toBeNull();
      expect(approver.decide(true)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
