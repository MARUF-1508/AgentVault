import { encodeFunctionData, erc20Abi, formatEther, maxUint256, parseUnits, type Hex } from 'viem';
import type { Approver } from '../approval/approver.js';
import { encodeAnchor } from '../audit/anchor.js';
import type { AuditLog } from '../audit/log.js';
import { explorerTx, type Clients } from '../chain/client.js';
import { agentVaultAbi, agentVaultV2Abi } from '../chain/vault.js';
import { encodeSwapCalldata, quoteExactInputSingle } from '../dex/uniswap.js';
import { compliantAlternative, type Alternative } from '../policy/alternative.js';
import { evaluate, intentAmount, intentAsset, tokenInfo } from '../policy/engine.js';
import { spendStateFrom } from '../policy/state.js';
import type { Decision, Intent, Policy, RiskInput, SpendState, SwapMarket } from '../policy/types.js';
import { whatIf, type WhatIfHypothesis, type WhatIfResult } from '../policy/whatif.js';
import { getPortfolio } from '../portfolio/portfolio.js';
import { usdValueBase, USD_SCALE } from '../prices/price.js';
import { checkAddress } from '../risk/address.js';
import { decodeCall, type TxRequest } from './decode.js';

/** How long an in-flight spend reservation is honoured before it is pruned. */
const RESERVATION_TTL_MS = 5 * 60 * 1000;
/** How long to wait for a receipt before reporting the transaction as pending. */
const RECEIPT_TIMEOUT_MS = 90_000;
/** Most transfers one batch may carry. */
export const MAX_BATCH = 10;

export interface ExecutionResult {
  /**
   * `pending`: broadcast, but no receipt arrived in time. It still counts toward
   * the budget; track it with `txStatus`.
   */
  status: 'executed' | 'denied' | 'rejected_by_human' | 'simulation_failed' | 'reverted' | 'dry_run' | 'pending';
  decision: Decision;
  txHash?: Hex;
  explorerUrl?: string;
  error?: string;
}

/** Where a broadcast transaction stands (T4). */
export interface TxStatus {
  hash: Hex;
  status: 'pending' | 'confirmed' | 'reverted' | 'unknown';
  blockNumber?: string;
  confirmations?: number;
  explorerUrl?: string;
  intent?: unknown;
  sentAt?: string;
}

/** One line of a batch preview: the verdict with everything earlier in the batch already counted. */
export interface BatchLine {
  index: number;
  intent: Intent;
  decision: Decision;
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
    /**
     * Optional on-chain guardrail (VAULT=true). Native transfers are then sent
     * as `agentSend` calls carrying zero value, so the vault's caps and
     * allowlist re-enforce the policy on-chain. Set `tokens` when the vault is an
     * `AgentVaultV2` (VAULT_TOKENS=true): ERC-20 transfers are then sent as
     * `agentSendToken` calls, so the same on-chain enforcement covers tokens too.
     * Policy evaluation is unchanged either way.
     */
    private readonly vault?: { address: `0x${string}`; tokens?: boolean },
  ) {}

  /**
   * Spend held for executions that have not broadcast yet, keyed by an
   * incrementing id. This is what closes the check-then-sign race between
   * concurrent requests (see `reserve`).
   */
  private readonly reservations = new Map<number, { asset: string; amountBase: bigint; expires: number }>();
  private nextReservation = 0;

  /**
   * Policy verdict without side effects (besides logging). Safe for the agent to
   * call freely. Any in-flight reservation is included, so a verdict taken while
   * another execution is mid-flight reflects the budget as it will really be.
   */
  async preview(intent: Intent): Promise<Decision> {
    const market = await this.marketFor(intent);
    const risk = await this.riskFor(intent);
    return this.evaluateWith(intent, market, risk, []);
  }

  /**
   * Read-only counterfactual: the verdict as things stand today versus the same
   * verdict under a hypothetical policy/state ("what if this recipient were
   * allowlisted?", "what if the daily budget were larger?"). It never signs and
   * never changes the policy, so it is safe advice for a human or a model; the
   * hypothesis only ever affects this one evaluation.
   */
  async whatIf(intent: Intent, hypothesis: WhatIfHypothesis = {}): Promise<WhatIfResult> {
    const market = await this.marketFor(intent);
    const risk = await this.riskFor(intent);
    const state = this.spendState();
    return whatIf(intent, this.policy, risk ? { ...state, risk } : state, this.clients.chain.id, hypothesis, market);
  }

  /**
   * Spend state plus reservations for executions that have not yet broadcast.
   * `except` is the current execution's own reservation, which must not be
   * counted against itself. Expired entries are pruned so a flow that crashed or
   * hung cannot freeze the budget forever.
   */
  private spendState(except: number[] = []): SpendState {
    const state = spendStateFrom(this.audit.read(), this.pauseFile, new Date(), this.policy.rateLimit.velocity?.windowMinutes);
    const now = Date.now();
    for (const [id, r] of this.reservations) {
      if (r.expires <= now) {
        this.reservations.delete(id);
        continue;
      }
      if (except.includes(id)) continue;
      // A reservation is a transaction about to be broadcast: it counts against
      // the budget, the hourly rate limit and the velocity window alike.
      state.spentToday[r.asset] = (state.spentToday[r.asset] ?? 0n) + r.amountBase;
      state.txLastHour++;
      if (state.velocity) {
        state.velocity.txInWindow++;
        state.velocity.spentInWindow[r.asset] = (state.velocity.spentInWindow[r.asset] ?? 0n) + r.amountBase;
      }
    }
    return state;
  }

  /**
   * Preview plus, when the verdict is not T1, the engine's own compliant
   * alternative (T1): the largest amount the same policy accepts, re-checked by
   * the engine. Read-only.
   */
  async previewWithAlternative(intent: Intent): Promise<{ decision: Decision; alternative?: Alternative }> {
    const market = await this.marketFor(intent);
    const risk = await this.riskFor(intent);
    const decision = this.evaluateWith(intent, market, risk, []);
    if (decision.tier === 'T1_AUTO') return { decision };
    const state = this.spendState();
    const alternative = compliantAlternative(intent, this.policy, risk ? { ...state, risk } : state, this.clients.chain.id);
    return alternative ? { decision, alternative } : { decision };
  }

  /**
   * Batch preview (T3): each transfer is evaluated as if every earlier line in
   * the batch had already gone through, so a batch cannot sneak past the daily
   * budget, the velocity guard or the rate limit one innocent-looking line at a
   * time. Read-only; the pure engine decides every line.
   */
  async previewBatch(intents: Intent[]): Promise<BatchLine[]> {
    if (intents.length === 0 || intents.length > MAX_BATCH) throw new Error(`A batch holds 1 to ${MAX_BATCH} transfers.`);
    const state = this.spendState();
    const lines: BatchLine[] = [];
    for (const [index, intent] of intents.entries()) {
      const market = await this.marketFor(intent);
      const risk = await this.riskFor(intent);
      const decision = evaluate(intent, this.policy, risk ? { ...state, risk } : state, this.clients.chain.id, market);
      lines.push({ index, intent, decision });
      if (decision.tier === 'T3_DENY') continue;
      const counts = intent.kind !== 'erc20_approve' && intent.kind !== 'audit_anchor';
      state.txLastHour++;
      if (state.velocity) state.velocity.txInWindow++;
      if (counts && decision.amountBase > 0n) {
        state.spentToday[decision.asset] = (state.spentToday[decision.asset] ?? 0n) + decision.amountBase;
        if (state.velocity) {
          state.velocity.spentInWindow[decision.asset] = (state.velocity.spentInWindow[decision.asset] ?? 0n) + decision.amountBase;
        }
      }
    }
    return lines;
  }

  /**
   * Executes a batch all-or-nothing at the policy level: if any line would be
   * refused (with the earlier lines counted), nothing is sent. Lines then run one
   * by one through `execute`, which re-checks each against the live state; the
   * batch stops at the first line that does not execute.
   */
  async executeBatch(
    intents: Intent[],
    opts: { dryRun?: boolean } = {},
  ): Promise<{ preview: BatchLine[]; results: ExecutionResult[]; stoppedAt?: number }> {
    const preview = await this.previewBatch(intents);
    this.audit.append('intent', { batch: intents.length, intents });
    if (preview.some((l) => l.decision.tier === 'T3_DENY')) {
      this.audit.append('decision', { tier: 'T3_DENY', reasons: ['Batch refused: at least one line breaks the policy.'], batch: true });
      return { preview, results: [] };
    }
    const results: ExecutionResult[] = [];
    for (const [i, intent] of intents.entries()) {
      const r = await this.execute(intent, { dryRun: opts.dryRun });
      results.push(r);
      const ok = r.status === 'executed' || r.status === 'dry_run' || r.status === 'pending';
      if (!ok) return { preview, results, stoppedAt: i };
    }
    return { preview, results };
  }

  /**
   * Status of a broadcast transaction (T4): from the audit log first, then from
   * the chain for anything still pending. A receipt found late is written to
   * the audit log, so the log converges on what the chain says.
   */
  async txStatus(hash: Hex): Promise<TxStatus> {
    const entries = this.audit.read();
    const sent = entries.find((e) => e.type === 'tx_sent' && e.data.hash === hash);
    const base: TxStatus = {
      hash,
      status: 'unknown',
      explorerUrl: explorerTx(this.clients.chain, hash),
      ...(sent ? { intent: sent.data.intent, sentAt: sent.ts } : {}),
    };
    const final = entries.find((e) => (e.type === 'tx_confirmed' || e.type === 'tx_failed') && e.data.hash === hash);
    let blockNumber: bigint | undefined;
    if (final) {
      base.status = final.type === 'tx_confirmed' ? 'confirmed' : 'reverted';
      blockNumber = final.data.blockNumber !== undefined ? BigInt(String(final.data.blockNumber)) : undefined;
    } else {
      try {
        const receipt = await this.clients.publicClient.getTransactionReceipt({ hash });
        blockNumber = receipt.blockNumber;
        base.status = receipt.status === 'success' ? 'confirmed' : 'reverted';
        if (sent) {
          this.audit.append(base.status === 'confirmed' ? 'tx_confirmed' : 'tx_failed', {
            hash,
            blockNumber: receipt.blockNumber,
            ...(base.status === 'confirmed' ? { gasUsed: receipt.gasUsed } : { stage: 'receipt' }),
            late: true,
          });
        }
      } catch {
        base.status = sent ? 'pending' : 'unknown';
      }
    }
    if (blockNumber !== undefined) {
      base.blockNumber = blockNumber.toString();
      try {
        const head = await this.clients.publicClient.getBlockNumber();
        base.confirmations = Number(head - blockNumber + 1n);
      } catch {
        // confirmations are best-effort
      }
    }
    return base;
  }

  /** Broadcast transactions with no receipt in the audit log yet. */
  pendingTxs(): { hash: string; sentAt: string; intent: unknown }[] {
    const entries = this.audit.read();
    const done = new Set(
      entries.filter((e) => e.type === 'tx_confirmed' || e.type === 'tx_failed').map((e) => String(e.data.hash)),
    );
    return entries
      .filter((e) => e.type === 'tx_sent' && !done.has(String(e.data.hash)))
      .map((e) => ({ hash: String(e.data.hash), sentAt: e.ts, intent: e.data.intent }));
  }

  /** The single seam into the pure engine: current state (with reservations) in, a decision out. */
  private evaluateWith(
    intent: Intent,
    market: SwapMarket | undefined,
    risk: RiskInput | undefined,
    except: number[],
    envelope?: SpendState['envelope'],
  ): Decision {
    const state = this.spendState(except);
    const withRisk = risk ? { ...state, risk } : state;
    return evaluate(intent, this.policy, envelope ? { ...withRisk, envelope } : withRisk, this.clients.chain.id, market);
  }

  /**
   * Derives a task's envelope from the audit log: the cap (`taskMax`, in the
   * intent's own asset) and how much the same task has already spent on that
   * asset. Undefined when the asset is unknown, so a bad envelope simply leaves
   * the task unbounded rather than silently blocking it. Only entries that count
   * toward the budget are summed, so approvals never consume an envelope.
   */
  private taskEnvelope(intent: Intent, task: string, taskMax: string): SpendState['envelope'] | undefined {
    const asset = intentAsset(intent, this.policy);
    if (!asset) return undefined;
    let budgetBase: bigint;
    try {
      budgetBase = parseUnits(taskMax, asset.decimals);
    } catch {
      return undefined;
    }
    let spentBase = 0n;
    for (const e of this.audit.read()) {
      if (e.type !== 'tx_sent' || e.data.task !== task || !e.data.countsToBudget) continue;
      if (String(e.data.asset) !== asset.symbol) continue;
      spentBase += BigInt(String(e.data.amountBase));
    }
    return { asset: asset.symbol, budgetBase, spentBase };
  }

  /**
   * Holds this execution's amount against the budget until it broadcasts (the
   * amount then counts from the audit log) or gives up. Reserving and the
   * authoritative re-check that follows run without an `await` between them, so
   * two concurrent executions can no longer both pass the budget check and
   * overspend: whichever reserves first is visible to the other's re-check.
   */
  private reserve(decision: Decision, countsToBudget: boolean): number {
    const id = ++this.nextReservation;
    if (countsToBudget && decision.amountBase > 0n) {
      this.reservations.set(id, {
        asset: decision.asset,
        amountBase: decision.amountBase,
        expires: Date.now() + RESERVATION_TTL_MS,
      });
    }
    return id;
  }

  private release(id: number): void {
    this.reservations.delete(id);
  }

  /**
   * Chain-derived risk input for the pure engine (Day 3): recipient intel plus,
   * when the anomaly guard is on, the portfolio value and this request's USD
   * value. Missing fields leave the corresponding check off.
   */
  private async riskFor(intent: Intent): Promise<RiskInput | undefined> {
    const risk: RiskInput = {};

    const target = this.recipientOf(intent);
    if (target) risk.recipient = await checkAddress(this.clients.publicClient, this.policy, target);

    const maxPct = this.policy.risk?.maxActionPctOfPortfolio ?? 0;
    if (maxPct > 0 && this.clients.account) {
      // Best-effort: a transient RPC failure on one token read must never abort a
      // preview or a transfer. The engine treats a missing portfolio value as
      // "guard unknown" and leaves it off; the per-tx hard cap and the daily
      // budget still bound the loss, so this is availability, not a weakening of
      // the firewall. The other risk findings below are unaffected.
      try {
        const portfolio = await getPortfolio(this.clients, this.policy);
        const total = tryParseUnits(portfolio.totalUsd, USD_SCALE);
        if (total !== undefined && total > 0n) {
          risk.portfolioUsd = total;
          const asset = intentAsset(intent, this.policy);
          const holding = asset
            ? portfolio.holdings.find((h) => h.asset.toLowerCase() === asset.symbol.toLowerCase())
            : undefined;
          const amount = asset ? tryParseUnits(intentAmount(intent), asset.decimals) : undefined;
          if (amount !== undefined && holding?.usdPrice) {
            risk.amountUsd = usdValueBase(amount, asset!.decimals, holding.usdPrice);
          }
        }
      } catch {
        // Leave portfolioUsd/amountUsd unset; the anomaly guard stays off.
      }
    }

    return Object.keys(risk).length > 0 ? risk : undefined;
  }

  /** The address a transfer/approval commits to, when there is one. */
  private recipientOf(intent: Intent): `0x${string}` | undefined {
    if (intent.kind === 'native_transfer' || intent.kind === 'erc20_transfer') return intent.to;
    if (intent.kind === 'erc20_approve') return intent.spender;
    return undefined;
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

  async execute(intent: Intent, opts: { dryRun?: boolean; task?: string; taskMax?: string } = {}): Promise<ExecutionResult> {
    const { walletClient, publicClient, account, chain } = this.clients;
    this.audit.append('intent', { intent, ...(opts.task ? { task: opts.task } : {}) });

    // A task envelope bounds everything one goal may spend, independently of the
    // daily budget. It is derived from the audit log (entries tagged with the same
    // task) and re-evaluated on every attempt, so it holds even across separate
    // executions and across a human-approval wait.
    const envelope = opts.task && opts.taskMax ? this.taskEnvelope(intent, opts.task, opts.taskMax) : undefined;

    const market = await this.marketFor(intent);
    const risk = await this.riskFor(intent);
    const decision = this.evaluateWith(intent, market, risk, [], envelope);
    this.audit.append('decision', { tier: decision.tier, reasons: decision.reasons, asset: decision.asset, ...(opts.task ? { task: opts.task } : {}) });
    if (decision.tier === 'T3_DENY') return { status: 'denied', decision };

    if (!walletClient || !account) {
      return { status: 'denied', decision, error: 'No AGENT_PRIVATE_KEY configured; wallet is read-only.' };
    }

    const req = this.buildTx(intent, decision);

    // Simulate before asking a human, so we never ask them to approve something that would revert.
    let gasFee: bigint | undefined;
    let gas = 0n;
    try {
      await publicClient.call({ account, to: req.to, value: req.value, data: req.data });
      gas = await publicClient.estimateGas({ account, to: req.to, value: req.value, data: req.data });
      // Best-effort: the estimated fee goes on the human approval card.
      try {
        gasFee = gas * (await publicClient.getGasPrice());
      } catch {
        gasFee = undefined;
      }
      this.audit.append('simulation', { ok: true, gas });
    } catch (err) {
      const msg = shortError(err);
      this.audit.append('simulation', { ok: false, error: msg });
      return { status: 'simulation_failed', decision, error: msg };
    }

    if (opts.dryRun) return { status: 'dry_run', decision };

    if (decision.tier === 'T2_CONFIRM') {
      const ok = await this.approver.confirm(this.describe(intent, decision, { gas, gasFee }));
      this.audit.append('approval', { approved: ok, by: 'human' });
      if (!ok) return { status: 'rejected_by_human', decision };
    }

    // Re-check right before signing: the budget or the kill switch may have
    // changed while waiting for a human. Reserving and re-checking are done in
    // one synchronous step (no `await` between `reserve` and `evaluateWith`), so
    // a second concurrent execution sees the first one's reservation and cannot
    // both pass the same budget. The reservation is released on every exit.
    const marketAtSign = await this.marketFor(intent);
    const riskAtSign = await this.riskFor(intent);
    const countsToBudget = intent.kind !== 'erc20_approve' && intent.kind !== 'audit_anchor';
    const reservation = this.reserve(decision, countsToBudget);
    try {
      const recheck = this.evaluateWith(intent, marketAtSign, riskAtSign, [reservation], envelope);
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
        countsToBudget,
        ...(opts.task ? { task: opts.task } : {}),
      });
      // From here the spend counts from the audit log; keeping the reservation
      // as well would count it twice and falsely refuse concurrent requests.
      this.release(reservation);

      let receipt;
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      } catch (err) {
        // Broadcast but unconfirmed: never silently drop it. It already counts
        // toward the budget (tx_sent), and txStatus() can follow it up later.
        this.audit.append('tx_pending', { hash, error: shortError(err) });
        return { status: 'pending', decision, txHash: hash, explorerUrl, error: 'No receipt yet; the transaction is pending.' };
      }
      if (receipt.status !== 'success') {
        this.audit.append('tx_failed', { hash, stage: 'receipt', blockNumber: receipt.blockNumber });
        return { status: 'reverted', decision, txHash: hash, explorerUrl };
      }
      this.audit.append('tx_confirmed', { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed });
      return { status: 'executed', decision, txHash: hash, explorerUrl };
    } finally {
      this.release(reservation);
    }
  }

  private buildTx(intent: Intent, decision: Decision): TxRequest {
    if (intent.kind === 'audit_anchor') {
      const self = this.clients.account?.address;
      if (!self) throw new Error('Cannot anchor without a wallet key.');
      return { to: self, value: 0n, data: encodeAnchor(intent.seq, intent.headHash) };
    }
    if (intent.kind === 'native_transfer') {
      // Vault mode: the vault (pre-funded by the owner) pays out; this call
      // carries no value itself, so a stolen agent key cannot move more than
      // the vault's on-chain caps even off-policy.
      if (this.vault) {
        return {
          to: this.vault.address,
          value: 0n,
          data: encodeFunctionData({
            abi: agentVaultAbi,
            functionName: 'agentSend',
            args: [intent.to, parseUnits(intent.amount, 18)],
          }),
        };
      }
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
      const amount = parseUnits(intent.amount, token.decimals);
      // V2 vault mode: the vault holds the tokens and re-enforces its own token
      // cap on-chain, so a stolen agent key cannot move more than the daily token
      // limit even off-policy. Opt-in (VAULT_TOKENS=true) because it needs the
      // vault funded with the token and the token allowed by the owner.
      if (this.vault?.tokens) {
        return {
          to: this.vault.address,
          value: 0n,
          data: encodeFunctionData({
            abi: agentVaultV2Abi,
            functionName: 'agentSendToken',
            args: [token.address, intent.to, amount],
          }),
        };
      }
      return {
        to: token.address,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [intent.to, amount] }),
      };
    }
    const amount = intent.amount === 'unlimited' ? maxUint256 : parseUnits(intent.amount, token.decimals);
    return {
      to: token.address,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [intent.spender, amount] }),
    };
  }

  /**
   * Plain-language balance effect of the simulated transaction, for the human
   * approval card. Derived from the intent itself (we built it), never from the
   * model, so approving "what the card says" means approving what will execute.
   */
  effectLine(intent: Intent, d: Decision): string | null {
    const symbol = this.policy.native.symbol;
    if (intent.kind === 'audit_anchor') return `No value moves; records audit entry #${intent.seq} on-chain`;
    if (intent.kind === 'native_transfer') {
      return this.vault
        ? `-${intent.amount} ${symbol} from AgentVault, +${intent.amount} ${symbol} to ${intent.to}`
        : `-${intent.amount} ${symbol} from the wallet, +${intent.amount} ${symbol} to ${intent.to}`;
    }
    if (intent.kind === 'erc20_transfer') {
      const from = this.vault?.tokens ? 'AgentVault' : 'the wallet';
      return `-${intent.amount} ${d.asset} from ${from}, +${intent.amount} ${d.asset} to ${intent.to}`;
    }
    if (intent.kind === 'erc20_approve') {
      if (intent.amount === '0') return `Revokes the ${d.asset} allowance for ${intent.spender} (sets it to 0)`;
      return `Allowance: ${intent.spender} may spend up to ${intent.amount} ${d.asset} (replaces the current allowance)`;
    }
    return null;
  }

  describe(intent: Intent, d: Decision, sim?: { gas?: bigint; gasFee?: bigint }): string {
    const amt = intentAmount(intent);
    const target =
      intent.kind === 'erc20_approve'
        ? `spender ${intent.spender}`
        : intent.kind === 'swap'
          ? `router ${d.router ?? this.policy.swap?.router}`
          : intent.kind === 'audit_anchor'
            ? 'the wallet itself'
            : `to ${intent.to}`;
    const lines = [
      `  Action : ${intent.kind}`,
      `  Amount : ${amt} ${intent.kind === 'swap' ? '' : d.asset}`.trimEnd(),
      `  Target : ${target}`,
    ];
    const effect = this.effectLine(intent, d);
    if (effect) lines.push(`  Effect : ${effect}`);
    if (this.vault && (intent.kind === 'native_transfer' || (intent.kind === 'erc20_transfer' && this.vault.tokens))) {
      lines.push(`  Via    : AgentVault ${this.vault.address} (on-chain caps apply)`);
    }
    if (intent.kind === 'swap' && d.minAmountOut !== undefined) {
      lines.push(`  Min out: ${d.minAmountOut} (base units of ${intent.tokenOut})`);
    }
    // The decoded calldata of the exact transaction that will be signed (S6).
    try {
      lines.push(`  Call   : ${decodeCall(this.buildTx(intent, d), this.policy)}`);
    } catch {
      // Nothing buildable (read-only wallet); the lines above still describe it.
    }
    if (sim?.gas !== undefined) {
      const fee = sim.gasFee !== undefined ? ` (estimated fee ~${formatEther(sim.gasFee)} ${this.policy.native.symbol})` : '';
      lines.push(`  Gas    : ${sim.gas} units${fee}`);
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

/** parseUnits, but undefined instead of throwing (risk inputs are best-effort). */
function tryParseUnits(value: string, decimals: number): bigint | undefined {
  try {
    return parseUnits(value, decimals);
  } catch {
    return undefined;
  }
}

