import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../src/audit/log.js';
import type { Approver } from '../src/approval/approver.js';
import { DenyAllApprover } from '../src/approval/approver.js';
import type { Clients } from '../src/chain/client.js';
import { Executor } from '../src/executor/executor.js';
import { PolicySchema, type Policy } from '../src/policy/types.js';

export const ALICE: `0x${string}` = '0x4785Dca37A242F3D80f844CB0b143A687008a2B5';
export const BOB: `0x${string}` = '0x2222222222222222222222222222222222222222';
export const WALLET: `0x${string}` = '0x1111111111111111111111111111111111111111';
export const CHAIN_ID = 84532;

/** A small native-only policy shared by the newer tests. */
export function basePolicy(extra: Record<string, unknown> = {}): Policy {
  return PolicySchema.parse({
    version: 1,
    chainId: CHAIN_ID,
    native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.005', dailyBudget: '0.01' },
    tokens: {},
    recipients: { allowlist: { alice: ALICE }, denylist: [] },
    approvals: { allowUnlimited: false, spenderAllowlist: {} },
    rateLimit: { maxTxPerHour: 20 },
    ...extra,
  });
}

export interface SentTx {
  to: `0x${string}`;
  value: bigint;
  data?: `0x${string}`;
}

/**
 * A real audit log in a temp dir plus stub chain clients. `receipt` controls
 * what waitForTransactionReceipt does, so tests can model slow or lost receipts.
 */
export function harness(opts: {
  policy?: Policy;
  approver?: Approver;
  receipt?: (hash: string) => Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; gasUsed: bigint }>;
  getTransactionReceipt?: (hash: string) => Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; gasUsed: bigint }>;
  getTransaction?: (hash: string) => Promise<{ input: `0x${string}`; from: string; to: string | null } | null>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'av-test-'));
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  const sent: SentTx[] = [];
  let n = 0;
  const clients = {
    chain: { id: CHAIN_ID, name: 'Base Sepolia', blockExplorers: { default: { url: 'https://sepolia.basescan.org' } } },
    publicClient: {
      call: async () => ({}),
      estimateGas: async () => 21000n,
      getGasPrice: async () => 1n,
      getCode: async () => undefined,
      getBlockNumber: async () => 105n,
      waitForTransactionReceipt: async ({ hash }: { hash: string }) =>
        opts.receipt ? opts.receipt(hash) : { status: 'success', blockNumber: 100n, gasUsed: 21000n },
      getTransactionReceipt: async ({ hash }: { hash: string }) => {
        if (!opts.getTransactionReceipt) throw new Error('not found');
        return opts.getTransactionReceipt(hash);
      },
      getTransaction: async ({ hash }: { hash: string }) => (opts.getTransaction ? opts.getTransaction(hash) : null),
    },
    walletClient: {
      sendTransaction: async (tx: SentTx) => {
        sent.push(tx);
        n++;
        return `0x${n.toString(16).padStart(64, '0')}`;
      },
    },
    account: { address: WALLET },
  } as unknown as Clients;
  const policy = opts.policy ?? basePolicy();
  const executor = new Executor(clients, policy, audit, opts.approver ?? new DenyAllApprover(), join(dir, 'PAUSED'));
  return { executor, audit, sent, clients, policy, dir };
}
