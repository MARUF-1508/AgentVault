import { encodeFunctionData, erc20Abi, maxUint256, parseUnits, type Hex } from 'viem';
import type { Approver } from '../approval/approver.js';
import type { AuditLog } from '../audit/log.js';
import { explorerTx, type Clients } from '../chain/client.js';
import { encodeSwapCalldata, quoteExactInputSingle } from '../dex/uniswap.js';
import { evaluate, tokenInfo } from '../policy/engine.js';
import { spendStateFrom } from '../policy/state.js';
import type { Decision, Intent, Policy, SwapMarket } from '../policy/types.js';

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
  async preview(intent: Intent): Promise<Decision> {
    const state = spendStateFrom(this.audit.read(), this.pauseFile);
    const market = await this.marketFor(intent);
    return evaluate(intent, this.policy, state, this.clients.chain.id, market);
  }

  /**
   * Chain-derived input the pure engine needs for swaps: a fresh quote. Returning
   * undefined (quote reverted, no pool, unknown token) makes the engine deny, so a
   * broken market can never silently sign an unpriced swap.
   */
  private async marketFor(intent: Intent): Promise<SwapMarket | undefined> {
    if (intent.kind !== 'swap' || !this.policy.swap) return undefined;
    const tokenIn = tokenInfo(this.policy, intent.tokenIn);
    const tokenOut = tokenInfo(this.policy, intent.tokenOut);
    if (!tokenIn || !tokenOut) return undefined;
    try {
      const amountOut = await quoteExactInputSingle(this.clients.publicClient, this.policy.swap.quoter, {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: parseUnits(intent.amountIn, tokenIn.decimals),
        fee: this.policy.swap.feeTier,
      });
      return { amountOut };
    } catch {
      return undefined;
    }
  }

  async execute(intent: Intent, opts: { dryRun?: boolean } = {}): Promise<ExecutionResult> {
    const { walletClient, publicClient, account, chain } = this.clients;
    this.audit.append('intent', { intent });

    const decision = await this.preview(intent);
    this.audit.append('decision', { tier: decision.tier, reasons: decision.reasons, asset: decision.asset });
    if (decision.tier === 'T3_DENY') return { status: 'denied', decision };

    if (!walletClient || !account) {
      return { status: 'denied', decision, error: 'No AGENT_PRIVATE_KEY configured; wallet is read-only.' };
    }

    const req = this.buildTx(intent, decision);

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
    const recheck = await this.preview(intent);
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

  private buildTx(intent: Intent, decision: Decision): TxRequest {
    if (intent.kind === 'native_transfer') {
      return { to: intent.to, value: parseUnits(intent.amount, 18) };
    }
    if (intent.kind === 'swap') {
      const tokenIn = tokenInfo(this.policy, intent.tokenIn);
      const tokenOut = tokenInfo(this.policy, intent.tokenOut);
      const recipient = this.clients.account?.address;
      const router = decision.router ?? this.policy.swap?.router;
      const feeTier = this.policy.swap?.feeTier;
      if (!tokenIn || !tokenOut || !recipient || !router || feeTier === undefined || decision.minAmountOut === undefined) {
        throw new Error('Cannot build swap transaction: missing token, router or min-out.');
      }
      return {
        to: router,
        value: 0n,
        data: encodeSwapCalldata({
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          fee: feeTier,
          recipient,
          amountIn: parseUnits(intent.amountIn, tokenIn.decimals),
          amountOutMinimum: decision.minAmountOut,
        }),
      };
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
    const amt = intent.kind === 'swap' ? intent.amountIn : intent.amount;
    const target =
      intent.kind === 'erc20_approve'
        ? `spender ${intent.spender}`
        : intent.kind === 'swap'
          ? `router ${d.router ?? this.policy.swap?.router}`
          : `to ${intent.to}`;
    const lines = [
      `  Action : ${intent.kind}`,
      `  Amount : ${amt} ${intent.kind === 'swap' ? '' : d.asset}`.trimEnd(),
      `  Target : ${target}`,
    ];
    if (intent.kind === 'swap' && d.minAmountOut !== undefined) {
      lines.push(`  Min out: ${d.minAmountOut} (base units of ${intent.tokenOut})`);
    }
    lines.push(
      `  Chain  : ${this.clients.chain.name} (${this.clients.chain.id})`,
      `  Tier   : ${d.tier}`,
      `  Why    : ${d.reasons.join(' ')}`,
    );
    return lines.join('\n');
  }
}

function shortError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return e.shortMessage ?? e.message ?? String(err);
}

