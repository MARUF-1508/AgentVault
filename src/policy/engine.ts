import { formatUnits, getAddress, parseUnits } from 'viem';
import type { Decision, Intent, Policy, SpendState, SwapMarket } from './types.js';

/**
 * The policy firewall. A pure function: no network, no LLM, no clock.
 * Every state-changing action passes through here before anything is signed,
 * so the LLM can propose anything but can only ever execute what this allows.
 */
export function evaluate(
  intent: Intent,
  policy: Policy,
  state: SpendState,
  chainId: number,
  market?: SwapMarket,
): Decision {
  const deny = (asset: string, amountBase: bigint, ...reasons: string[]): Decision => ({
    tier: 'T3_DENY',
    reasons,
    amountBase,
    asset,
  });

  if (state.paused) return deny('?', 0n, 'Kill switch is on: the wallet is paused.');
  if (chainId !== policy.chainId) {
    return deny('?', 0n, `Connected to chain ${chainId} but the policy is for chain ${policy.chainId}.`);
  }
  if (state.txLastHour >= policy.rateLimit.maxTxPerHour) {
    return deny('?', 0n, `Rate limit reached: ${state.txLastHour} transactions in the last hour.`);
  }

  if (intent.kind === 'swap') return evaluateSwap(intent, policy, state, deny, market);

  const asset = resolveAsset(intent, policy);
  if (!asset) return deny('?', 0n, `Unknown token "${'token' in intent ? intent.token : '?'}" (not in policy).`);
  const { symbol, decimals, limits } = asset;

  const unlimited = intent.kind === 'erc20_approve' && intent.amount === 'unlimited';
  let amountBase: bigint;
  try {
    amountBase = unlimited ? 2n ** 256n - 1n : parseUnits(intent.amount as string, decimals);
  } catch {
    return deny(symbol, 0n, `Amount "${intent.amount}" is not a valid ${symbol} amount.`);
  }
  if (amountBase <= 0n) return deny(symbol, amountBase, 'Amount must be greater than zero.');

  const autoMax = parseUnits(limits.autoMaxPerTx, decimals);
  const hardMax = parseUnits(limits.hardMaxPerTx, decimals);
  const budget = parseUnits(limits.dailyBudget, decimals);
  const fmt = (v: bigint) => `${formatUnits(v, decimals)} ${symbol}`;

  const target = getAddress(intent.kind === 'erc20_approve' ? intent.spender : intent.to);
  if (policy.recipients.denylist.includes(target)) {
    return deny(symbol, amountBase, `${target} is on the denylist.`);
  }

  // Day 3 address risk. Findings from the risk module can only raise the tier.
  const recipient = state.risk?.recipient;
  if (recipient?.onBlocklist) {
    return deny(symbol, amountBase, `${target} is on the local block list.`);
  }
  if (recipient?.lookalikeOf) {
    return deny(
      symbol,
      amountBase,
      `${target} closely resembles allowlisted ${recipient.lookalikeOf} (possible address poisoning).`,
    );
  }

  if (intent.kind === 'erc20_approve') {
    if (unlimited && !policy.approvals.allowUnlimited) {
      return deny(symbol, amountBase, 'Unlimited token approvals are forbidden by policy.');
    }
    if (!Object.values(policy.approvals.spenderAllowlist).includes(target)) {
      return deny(symbol, amountBase, `Spender ${target} is not an allowlisted contract.`);
    }
    if (!unlimited && amountBase > hardMax) {
      return deny(symbol, amountBase, `Approval of ${fmt(amountBase)} exceeds the hard cap of ${fmt(hardMax)}.`);
    }
    if (unlimited || amountBase > autoMax) {
      return { tier: 'T2_CONFIRM', reasons: [`Approval above the auto limit of ${fmt(autoMax)}.`], amountBase, asset: symbol };
    }
    return { tier: 'T1_AUTO', reasons: ['Small approval to an allowlisted spender.'], amountBase, asset: symbol };
  }

  // Transfers
  if (amountBase > hardMax) {
    return deny(symbol, amountBase, `${fmt(amountBase)} exceeds the per-transaction hard cap of ${fmt(hardMax)}.`);
  }
  const spent = state.spentToday[symbol] ?? 0n;
  if (spent + amountBase > budget) {
    return deny(
      symbol,
      amountBase,
      `Daily budget exceeded: ${fmt(spent)} already spent today, budget is ${fmt(budget)}.`,
    );
  }

  const reasons: string[] = [];
  const known = Object.values(policy.recipients.allowlist).includes(target);
  if (!known) reasons.push(`${target} is a new recipient (not on the allowlist).`);
  if (amountBase > autoMax) reasons.push(`${fmt(amountBase)} is above the auto limit of ${fmt(autoMax)}.`);

  // Day 3: a non-allowlisted recipient that is a contract is at best a confirmation.
  if (!known && recipient?.isContract) {
    const mode = policy.risk?.contractRecipients ?? 'confirm';
    if (mode === 'deny') {
      return deny(symbol, amountBase, `${target} is a contract and policy denies contract recipients.`);
    }
    if (mode === 'confirm') reasons.push(`${target} is a contract (it has code), not an ordinary wallet.`);
  }

  // Day 3: refuse a single request that would move too much of the whole portfolio.
  const anomaly = anomalyReason(state, policy);
  if (anomaly) return deny(symbol, amountBase, anomaly);

  if (reasons.length > 0) return { tier: 'T2_CONFIRM', reasons, amountBase, asset: symbol };
  return {
    tier: 'T1_AUTO',
    reasons: [`Known recipient, within auto limit and daily budget (${fmt(spent + amountBase)} of ${fmt(budget)}).`],
    amountBase,
    asset: symbol,
  };
}

type Deny = (asset: string, amountBase: bigint, ...reasons: string[]) => Decision;

/**
 * Swap rules. Deny by default: swaps off unless configured, unknown tokens,
 * router not the allowlisted venue, router not an allowlisted spender, missing or
 * oversized slippage, over the hard cap or daily budget, or no fresh market quote.
 * The minimum output is derived here (purely) from the quote and the slippage cap,
 * so the LLM can never widen it.
 */
function evaluateSwap(
  intent: Extract<Intent, { kind: 'swap' }>,
  policy: Policy,
  state: SpendState,
  deny: Deny,
  market?: SwapMarket,
): Decision {
  if (!policy.swap) return deny('?', 0n, 'Swaps are not enabled in the policy.');

  const tokenIn = tokenInfo(policy, intent.tokenIn);
  const tokenOut = tokenInfo(policy, intent.tokenOut);
  if (!tokenIn || !tokenOut) {
    return deny('?', 0n, `Unknown token in swap ${intent.tokenIn} -> ${intent.tokenOut} (not in policy).`);
  }
  if (tokenIn.symbol === tokenOut.symbol) return deny(tokenIn.symbol, 0n, 'Cannot swap a token for itself.');

  const venue = getAddress(intent.router ?? policy.swap.router);
  if (venue !== getAddress(policy.swap.router)) {
    return deny(tokenIn.symbol, 0n, `Swap venue ${venue} is not the allowlisted router.`);
  }
  if (!Object.values(policy.approvals.spenderAllowlist).map((a) => getAddress(a)).includes(venue)) {
    return deny(tokenIn.symbol, 0n, `Swap router ${venue} is not in the spender allowlist.`);
  }

  if (intent.slippageBps <= 0) return deny(tokenIn.symbol, 0n, 'A positive slippage cap (bps) is required.');
  if (intent.slippageBps > policy.swap.maxSlippageBps) {
    return deny(tokenIn.symbol, 0n, `Slippage cap ${intent.slippageBps} bps exceeds the maximum of ${policy.swap.maxSlippageBps} bps.`);
  }

  let amountBase: bigint;
  try {
    amountBase = parseUnits(intent.amountIn, tokenIn.decimals);
  } catch {
    return deny(tokenIn.symbol, 0n, `Amount "${intent.amountIn}" is not a valid ${tokenIn.symbol} amount.`);
  }
  if (amountBase <= 0n) return deny(tokenIn.symbol, amountBase, 'Swap amount must be greater than zero.');

  const inAuto = parseUnits(tokenIn.autoMaxPerTx, tokenIn.decimals);
  const inHard = parseUnits(tokenIn.hardMaxPerTx, tokenIn.decimals);
  const inBudget = parseUnits(tokenIn.dailyBudget, tokenIn.decimals);
  const fmtIn = (v: bigint) => `${formatUnits(v, tokenIn.decimals)} ${tokenIn.symbol}`;
  if (amountBase > inHard) {
    return deny(tokenIn.symbol, amountBase, `${fmtIn(amountBase)} exceeds the per-transaction hard cap of ${fmtIn(inHard)}.`);
  }
  const spent = state.spentToday[tokenIn.symbol] ?? 0n;
  if (spent + amountBase > inBudget) {
    return deny(tokenIn.symbol, amountBase, `Daily budget exceeded: ${fmtIn(spent)} already spent today, budget is ${fmtIn(inBudget)}.`);
  }

  // Day 3: a swap also moves value; apply the portfolio anomaly guard.
  const anomaly = anomalyReason(state, policy);
  if (anomaly) return deny(tokenIn.symbol, amountBase, anomaly);

  if (!market || market.amountOut <= 0n) {
    return deny(tokenIn.symbol, amountBase, 'No valid market quote is available for this swap.');
  }
  // Minimum out is derived from the quote and the cap; the agent cannot widen it.
  const minAmountOut = (market.amountOut * BigInt(10_000 - intent.slippageBps)) / 10_000n;
  if (minAmountOut <= 0n) {
    return deny(tokenIn.symbol, amountBase, 'The slippage cap leaves no acceptable minimum output.');
  }

  const quote = `${formatUnits(market.amountOut, tokenOut.decimals)} ${tokenOut.symbol}`;
  const minOut = `${formatUnits(minAmountOut, tokenOut.decimals)} ${tokenOut.symbol}`;
  const reasons: string[] = [];
  if (intent.slippageBps > policy.swap.autoMaxSlippageBps) {
    reasons.push(`Slippage cap ${intent.slippageBps} bps is above the auto limit of ${policy.swap.autoMaxSlippageBps} bps.`);
  }
  if (amountBase > inAuto) reasons.push(`${fmtIn(amountBase)} is above the auto limit of ${fmtIn(inAuto)}.`);

  if (reasons.length > 0) {
    return {
      tier: 'T2_CONFIRM',
      reasons: [...reasons, `Swap ${fmtIn(amountBase)} for about ${quote} (min ${minOut}).`],
      amountBase,
      asset: tokenIn.symbol,
      minAmountOut,
      router: venue,
    };
  }
  return {
    tier: 'T1_AUTO',
    reasons: [`Bounded swap of ${fmtIn(amountBase)} for about ${quote} (min ${minOut}) via allowlisted router.`],
    amountBase,
    asset: tokenIn.symbol,
    minAmountOut,
    router: venue,
  };
}

function resolveAsset(intent: Exclude<Intent, { kind: 'swap' }>, policy: Policy) {
  if (intent.kind === 'native_transfer') {
    return { symbol: policy.native.symbol, decimals: 18, limits: policy.native, address: undefined };
  }
  const key = Object.keys(policy.tokens).find((k) => k.toLowerCase() === intent.token.toLowerCase());
  if (!key) return undefined;
  const t = policy.tokens[key]!;
  return { symbol: key, decimals: t.decimals, limits: t, address: t.address };
}

/**
 * The asset an intent spends, for USD valuation and risk checks. For a swap this
 * is the input token. Undefined when the token is not in the policy.
 */
export function intentAsset(intent: Intent, policy: Policy): { symbol: string; decimals: number } | undefined {
  if (intent.kind === 'swap') {
    const t = tokenInfo(policy, intent.tokenIn);
    return t ? { symbol: t.symbol, decimals: t.decimals } : undefined;
  }
  const a = resolveAsset(intent, policy);
  return a ? { symbol: a.symbol, decimals: a.decimals } : undefined;
}

/** The human-readable amount string an intent carries. */
export function intentAmount(intent: Intent): string {
  return intent.kind === 'swap' ? intent.amountIn : (intent.amount as string);
}

/**
 * Portfolio anomaly guard: deny when this single request is worth more than the
 * configured share of the whole portfolio. Pure: the USD values are chain-derived
 * inputs passed in via `SpendState.risk`. Disabled when the cap is 0 or unknown.
 */
function anomalyReason(state: SpendState, policy: Policy): string | undefined {
  const maxPct = policy.risk?.maxActionPctOfPortfolio ?? 0;
  if (maxPct <= 0) return undefined;
  const portfolioUsd = state.risk?.portfolioUsd;
  const amountUsd = state.risk?.amountUsd;
  if (portfolioUsd === undefined || portfolioUsd <= 0n) return undefined;
  if (amountUsd === undefined || amountUsd <= 0n) return undefined;
  if (amountUsd * 100n > portfolioUsd * BigInt(maxPct)) {
    return `Anomaly guard: one request worth ~$${formatUnits(amountUsd, 8)} is more than ${maxPct}% of the ~$${formatUnits(portfolioUsd, 8)} portfolio.`;
  }
  return undefined;
}

export function tokenInfo(policy: Policy, symbol: string) {
  const key = Object.keys(policy.tokens).find((k) => k.toLowerCase() === symbol.toLowerCase());
  return key ? { symbol: key, ...policy.tokens[key]! } : undefined;
}
