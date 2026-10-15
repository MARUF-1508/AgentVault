import { formatUnits, getAddress, parseUnits } from 'viem';
import type { Decision, Intent, Policy, SpendState } from './types.js';

/**
 * The policy firewall. A pure function: no network, no LLM, no clock.
 * Every state-changing action passes through here before anything is signed,
 * so the LLM can propose anything but can only ever execute what this allows.
 */
export function evaluate(intent: Intent, policy: Policy, state: SpendState, chainId: number): Decision {
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

  if (reasons.length > 0) return { tier: 'T2_CONFIRM', reasons, amountBase, asset: symbol };
  return {
    tier: 'T1_AUTO',
    reasons: [`Known recipient, within auto limit and daily budget (${fmt(spent + amountBase)} of ${fmt(budget)}).`],
    amountBase,
    asset: symbol,
  };
}

function resolveAsset(intent: Intent, policy: Policy) {
  if (intent.kind === 'native_transfer') {
    return { symbol: policy.native.symbol, decimals: 18, limits: policy.native, address: undefined };
  }
  const key = Object.keys(policy.tokens).find((k) => k.toLowerCase() === intent.token.toLowerCase());
  if (!key) return undefined;
  const t = policy.tokens[key]!;
  return { symbol: key, decimals: t.decimals, limits: t, address: t.address };
}

export function tokenInfo(policy: Policy, symbol: string) {
  const key = Object.keys(policy.tokens).find((k) => k.toLowerCase() === symbol.toLowerCase());
  return key ? { symbol: key, ...policy.tokens[key]! } : undefined;
}
