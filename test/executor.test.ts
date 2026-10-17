import { describe, expect, it } from 'vitest';
import { encodeFunctionData } from 'viem';
import { AuditLog } from '../src/audit/log.js';
import type { Clients } from '../src/chain/client.js';
import { agentVaultAbi } from '../src/chain/vault.js';
import { DenyAllApprover } from '../src/approval/approver.js';
import { Executor } from '../src/executor/executor.js';
import { PolicySchema } from '../src/policy/types.js';

const ALICE = '0x4785Dca37A242F3D80f844CB0b143A687008a2B5';
const VAULT = '0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388';
const CHAIN_ID = 84532;

const policy = PolicySchema.parse({
  version: 1,
  chainId: CHAIN_ID,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: {},
  recipients: { allowlist: { alice: ALICE }, denylist: [] },
  approvals: { allowUnlimited: false, spenderAllowlist: {} },
  rateLimit: { maxTxPerHour: 5 },
});

interface SentTx {
  to: `0x${string}`;
  value: bigint;
  data?: `0x${string}`;
}

function harness(vault?: { address: `0x${string}` }) {
  const sent: SentTx[] = [];
  const audit = { append: () => ({}), read: () => [] } as unknown as AuditLog;
  const clients = {
    chain: { id: CHAIN_ID, name: 'Base Sepolia' },
    publicClient: {
      call: async () => ({}),
      estimateGas: async () => 60000n,
      waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n, gasUsed: 1n }),
    },
    walletClient: {
      sendTransaction: async (tx: SentTx) => {
        sent.push(tx);
        return '0xhash';
      },
    },
    account: { address: '0x1111111111111111111111111111111111111111' },
  } as unknown as Clients;
  const executor = new Executor(clients, policy, audit, new DenyAllApprover(), '/nonexistent/PAUSED', vault);
  return { executor, sent };
}

const T2 = { tier: 'T2_CONFIRM' as const, reasons: ['new recipient'], amountBase: 500000000000000n, asset: 'ETH' };

describe('approval card', () => {
  it('states the exact balance effect and the estimated gas fee', () => {
    const { executor } = harness();
    const text = executor.describe({ kind: 'native_transfer', to: ALICE, amount: '0.0005' }, T2, {
      gas: 21000n,
      gasFee: 21000000000000n,
    });
    expect(text).toContain(`Effect : -0.0005 ETH from the wallet, +0.0005 ETH to ${ALICE}`);
    expect(text).toContain('Gas    : 21000 units (estimated fee ~0.000021 ETH)');
  });

  it('names the vault as the source when vault mode is on', () => {
    const { executor } = harness({ address: VAULT });
    const text = executor.describe({ kind: 'native_transfer', to: ALICE, amount: '0.0005' }, T2);
    expect(text).toContain(`Effect : -0.0005 ETH from AgentVault, +0.0005 ETH to ${ALICE}`);
    expect(text).not.toContain('Gas    :');
  });

  it('spells out an allowance grant instead of pretending it is a transfer', () => {
    const { executor } = harness();
    const spender = '0x3333333333333333333333333333333333333333';
    const text = executor.describe(
      { kind: 'erc20_approve', token: '0x4444444444444444444444444444444444444444', spender, amount: '5' },
      { tier: 'T2_CONFIRM', reasons: ['allowance above the auto limit'], amountBase: 5000000n, asset: 'USDC' },
    );
    expect(text).toContain(`Effect : Allowance: ${spender} may spend up to 5 USDC (replaces the current allowance)`);
    expect(text).not.toContain('-5 USDC');
  });
});

describe('vault routing (VAULT=true)', () => {
  it('routes a T1 native transfer through agentSend with zero value', async () => {
    const { executor, sent } = harness({ address: VAULT });
    const r = await executor.execute({ kind: 'native_transfer', to: ALICE, amount: '0.0005' });
    expect(r.status).toBe('executed');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(VAULT);
    expect(sent[0]!.value).toBe(0n);
    expect(sent[0]!.data).toBe(
      encodeFunctionData({ abi: agentVaultAbi, functionName: 'agentSend', args: [ALICE, 500000000000000n] }),
    );
  });

  it('policy still decides: an over-cap transfer never reaches the vault', async () => {
    const { executor, sent } = harness({ address: VAULT });
    const r = await executor.execute({ kind: 'native_transfer', to: ALICE, amount: '0.5' });
    expect(r.status).toBe('denied');
    expect(r.decision.tier).toBe('T3_DENY');
    expect(sent).toHaveLength(0);
  });

  it('without vault config the transfer goes directly to the recipient', async () => {
    const { executor, sent } = harness(undefined);
    const r = await executor.execute({ kind: 'native_transfer', to: ALICE, amount: '0.0005' });
    expect(r.status).toBe('executed');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(ALICE);
    expect(sent[0]!.data).toBeUndefined();
  });
});
