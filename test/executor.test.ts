import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi } from 'viem';
import { AuditLog } from '../src/audit/log.js';
import type { Clients } from '../src/chain/client.js';
import { agentVaultAbi, agentVaultV2Abi } from '../src/chain/vault.js';
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

function harness(vault?: { address: `0x${string}`; tokens?: boolean }, activePolicy = policy) {
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
  const executor = new Executor(clients, activePolicy, audit, new DenyAllApprover(), '/nonexistent/PAUSED', vault);
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

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const STRANGER = '0x2222222222222222222222222222222222222222';

const tokenPolicy = PolicySchema.parse({
  version: 1,
  chainId: CHAIN_ID,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: { USDC: { address: USDC, decimals: 6, autoMaxPerTx: '1', hardMaxPerTx: '10', dailyBudget: '25' } },
  recipients: { allowlist: { alice: ALICE }, denylist: [] },
  approvals: { allowUnlimited: false, spenderAllowlist: {} },
  rateLimit: { maxTxPerHour: 5 },
});

describe('vault token routing (VAULT_TOKENS=true)', () => {
  it('sends an ERC-20 transfer through agentSendToken, zero value', async () => {
    const { executor, sent } = harness({ address: VAULT, tokens: true }, tokenPolicy);
    const r = await executor.execute({ kind: 'erc20_transfer', token: 'USDC', to: ALICE, amount: '1' });
    expect(r.status).toBe('executed');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(VAULT);
    expect(sent[0]!.value).toBe(0n);
    expect(sent[0]!.data).toBe(
      encodeFunctionData({ abi: agentVaultV2Abi, functionName: 'agentSendToken', args: [USDC, ALICE, 1000000n] }),
    );
  });

  it('names the vault as the token source in the approval card', () => {
    const { executor } = harness({ address: VAULT, tokens: true }, tokenPolicy);
    const text = executor.describe(
      { kind: 'erc20_transfer', token: 'USDC', to: ALICE, amount: '1' },
      { tier: 'T2_CONFIRM', reasons: ['new recipient'], amountBase: 1000000n, asset: 'USDC' },
    );
    expect(text).toContain('from AgentVault');
    expect(text).toContain(`Via    : AgentVault ${VAULT}`);
  });

  it('without token mode the transfer goes straight from the wallet to the token contract', async () => {
    const { executor, sent } = harness(undefined, tokenPolicy);
    const r = await executor.execute({ kind: 'erc20_transfer', token: 'USDC', to: ALICE, amount: '1' });
    expect(r.status).toBe('executed');
    expect(sent[0]!.to).toBe(USDC);
    expect(sent[0]!.data).toBe(
      encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ALICE, 1000000n] }),
    );
  });
});

describe('stale-allowance cleanup (approve 0)', () => {
  it('encodes approve(spender, 0) and sends it with no approval and no budget reservation', async () => {
    const { executor, sent } = harness(undefined, tokenPolicy);
    const r = await executor.execute({ kind: 'erc20_approve', token: 'USDC', spender: STRANGER, amount: '0' });
    expect(r.status).toBe('executed');
    expect(r.decision.tier).toBe('T1_AUTO');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(USDC);
    expect(sent[0]!.value).toBe(0n);
    expect(sent[0]!.data).toBe(
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [STRANGER, 0n] }),
    );
  });

  it('describes a revoke as shrinking the allowance', () => {
    const { executor } = harness(undefined, tokenPolicy);
    const text = executor.describe(
      { kind: 'erc20_approve', token: 'USDC', spender: STRANGER, amount: '0' },
      { tier: 'T1_AUTO', reasons: [], amountBase: 0n, asset: 'USDC' },
    );
    expect(text).toContain('Revokes the USDC allowance');
  });
});

/** A policy whose whole daily budget fits in one and a half of the transfers below. */
const tightPolicy = PolicySchema.parse({
  version: 1,
  chainId: CHAIN_ID,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.001' },
  tokens: {},
  recipients: { allowlist: { alice: ALICE }, denylist: [] },
  approvals: { allowUnlimited: false, spenderAllowlist: {} },
  rateLimit: { maxTxPerHour: 5 },
});

describe('concurrent budget (reservation ledger)', () => {
  it('an in-flight execution reserves its amount, so a second request cannot spend the same budget', async () => {
    // Gate the first execution at the signing step: by then it holds its
    // reservation. A second, concurrent request for the same amount must see that
    // reservation and be refused, so the budget is never overdrawn. Without the
    // ledger both would read an empty budget and both would be sent.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let entered = false;
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
          entered = true;
          await gate;
          sent.push(tx);
          return '0xhash';
        },
      },
      account: { address: '0x1111111111111111111111111111111111111111' },
    } as unknown as Clients;
    const executor = new Executor(clients, tightPolicy, audit, new DenyAllApprover(), '/nonexistent/PAUSED');

    const first = executor.execute({ kind: 'native_transfer', to: ALICE, amount: '0.0006' });
    for (let i = 0; i < 100 && !entered; i++) await new Promise((r) => setTimeout(r, 1));
    expect(entered).toBe(true);

    const second = await executor.execute({ kind: 'native_transfer', to: ALICE, amount: '0.0006' });
    expect(second.status).toBe('denied');
    expect(second.decision.tier).toBe('T3_DENY');
    expect(second.decision.reasons.join(' ')).toMatch(/budget/i);

    open();
    const firstResult = await first;
    expect(firstResult.status).toBe('executed');
    expect(sent).toHaveLength(1);
  });
});

describe('availability: a failed portfolio read must not block a transfer', () => {
  const riskPolicy = PolicySchema.parse({
    version: 1,
    chainId: CHAIN_ID,
    native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
    tokens: {},
    recipients: { allowlist: { alice: ALICE }, denylist: [] },
    approvals: { allowUnlimited: false, spenderAllowlist: {} },
    risk: { maxActionPctOfPortfolio: 50 },
    rateLimit: { maxTxPerHour: 5 },
  });

  it('skips the anomaly guard instead of aborting when the portfolio read throws', async () => {
    const sent: SentTx[] = [];
    const audit = { append: () => ({}), read: () => [] } as unknown as AuditLog;
    const clients = {
      chain: { id: CHAIN_ID, name: 'Base Sepolia' },
      publicClient: {
        getBalance: async () => {
          throw new Error('RPC unavailable');
        },
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
    const executor = new Executor(clients, riskPolicy, audit, new DenyAllApprover(), '/nonexistent/PAUSED');

    const r = await executor.execute({ kind: 'native_transfer', to: ALICE, amount: '0.0005' });
    expect(r.status).toBe('executed');
    expect(sent).toHaveLength(1);
  });
});
