import { encodeFunctionData, erc20Abi, maxUint256, parseUnits, type Hex } from 'viem';
import type { Approver } from '../approval/approver.js';
import type { AuditLog } from '../audit/log.js';
import { explorerTx, type Clients } from '../chain/client.js';
import { evaluate, tokenInfo } from '../policy/engine.js';
import { spendStateFrom } from '../policy/state.js';
import type { Decision, Intent, Policy } from '../policy/types.js';

export interface ExecutionResult {
  status: 'executed' | 'denied' | 'rejected_by_human' | 'simulation_failed' | 'reverted' | 'dry_run';
  decision: Decision;
  txHash?: Hex;
  explorerUrl?: string;
  error?: string;
}

interface TxRequest {
  to: `0x${string}`;
  value: bigint;
  data?: Hex;
}

/**
 * The only component that can sign. Pipeline:
 * intent -> policy (deterministic) -> human approval (T2) -> simulation -> sign + send -> receipt -> audit.
 */
export class Executor {
  constructor(
    private readonly clients: Clients,
    private readonly policy: Policy,
    private readonly audit: AuditLog,
    private readonly approver: Approver,
    private readonly pauseFile: string,
  ) {}

  /** Policy verdict without side effects (besides logging). Safe for the agent to call freely. */
  preview(intent: Intent): Decision {
    const state = spendStateFrom(this.audit.read(), this.pauseFile);
    return evaluate(intent, this.policy, state, this.clients.chain.id);
  }

  async execute(intent: Intent, opts: { dryRun?: boolean } = {}): Promise<ExecutionResult> {
    const { walletClient, publicClient, account, chain } = this.clients;
    this.audit.append('intent', { intent });

    const decision = this.preview(intent);
    this.audit.append('decision', { tier: decision.tier, reasons: decision.reasons, asset: decision.asset });
    if (decision.tier === 'T3_DENY') return { status: 'denied', decision };

    if (!walletClient || !account) {
      return { status: 'denied', decision, error: 'No AGENT_PRIVATE_KEY configured; wallet is read-only.' };
    }

    const req = this.buildTx(intent);

    // Simulate before asking a human, so we never ask them to approve something that would revert.
    try {
      await publicClient.call({ account, to: req.to, value: req.value, data: req.data });
      const gas = await publicClient.estimateGas({ account, to: req.to, value: req.value, data: req.data });
      this.audit.append('simulation', { ok: true, gas });
    } catch (err) {
      const msg = shortError(err);
      this.audit.append('simulation', { ok: false, error: msg });
      return { status: 'simulation_failed', decision, error: msg };
    }

    if (opts.dryRun) return { status: 'dry_run', decision };

    if (decision.tier === 'T2_CONFIRM') {
      const ok = await this.approver.confirm(this.describe(intent, decision));
      this.audit.append('approval', { approved: ok, by: 'human' });
      if (!ok) return { status: 'rejected_by_human', decision };
    }

    // Re-check right before signing: budget/kill switch may have changed while waiting for a human.
    const recheck = this.preview(intent);
    if (recheck.tier === 'T3_DENY') {
      this.audit.append('decision', { tier: recheck.tier, reasons: recheck.reasons, recheck: true });
      return { status: 'denied', decision: recheck };
    }

    let hash: Hex;
    try {
      hash = await walletClient.sendTransaction({ to: req.to, value: req.value, data: req.data, chain, account });
    } catch (err) {
      const msg = shortError(err);
      this.audit.append('tx_failed', { stage: 'send', error: msg });
      return { status: 'simulation_failed', decision, error: msg };
    }
    const explorerUrl = explorerTx(chain, hash);
    this.audit.append('tx_sent', {
      hash,
      explorerUrl,
      chainId: chain.id,
      intent,
      tier: decision.tier,
      asset: decision.asset,
      amountBase: decision.amountBase,
      countsToBudget: intent.kind !== 'erc20_approve',
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      this.audit.append('tx_failed', { hash, stage: 'receipt', blockNumber: receipt.blockNumber });
      return { status: 'reverted', decision, txHash: hash, explorerUrl };
    }
    this.audit.append('tx_confirmed', { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed });
    return { status: 'executed', decision, txHash: hash, explorerUrl };
  }

  private buildTx(intent: Intent): TxRequest {
    if (intent.kind === 'native_transfer') {
      return { to: intent.to, value: parseUnits(intent.amount, 18) };
    }
    const token = tokenInfo(this.policy, intent.token);
    if (!token) throw new Error(`Unknown token ${intent.token}`);
    if (intent.kind === 'erc20_transfer') {
      return {
        to: token.address,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [intent.to, parseUnits(intent.amount, token.decimals)],
        }),
      };
    }
    const amount = intent.amount === 'unlimited' ? maxUint256 : parseUnits(intent.amount, token.decimals);
    return {
      to: token.address,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [intent.spender, amount] }),
    };
  }

  describe(intent: Intent, d: Decision): string {
    const amt = 'amount' in intent ? intent.amount : '';
    const target = intent.kind === 'erc20_approve' ? `spender ${intent.spender}` : `to ${intent.to}`;
    return [
      `  Action : ${intent.kind}`,
      `  Amount : ${amt} ${d.asset}`,
      `  Target : ${target}`,
      `  Chain  : ${this.clients.chain.name} (${this.clients.chain.id})`,
      `  Tier   : ${d.tier}`,
      `  Why    : ${d.reasons.join(' ')}`,
    ].join('\n');
  }
}

function shortError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return e.shortMessage ?? e.message ?? String(err);
}

