import { formatUnits, getAddress, parseUnits } from 'viem';
import { evaluate, tokenInfo } from './engine.js';
import type { Decision, Intent, Policy, SpendState, Tier } from './types.js';

/**
 * Compliant alternatives (T1). When the engine refuses a transfer, or parks it
 * for a human only because the amount is above the auto limit, this works out
 * the largest amount the *same* policy would accept and proves it by running the
 * engine again on that amount. Pure, like the engine: it never signs and never
 * relaxes a rule; it only searches inside the rules as they are.
 */
export type Alternative =
  | { kind: 'amount'; intent: Intent; decision: Decision; note: string }
  | { kind: 'none'; note: string };

/** One-line, plain-language meaning of a tier, for the agent and the UI. */
export function explainTier(tier: Tier): string {
  switch (tier) {
    case 'T1_AUTO':
      return 'T1 (automatic): inside the auto limit to a known recipient, so it executes without a human.';
    case 'T2_CONFIRM':
      return 'T2 (needs approval): allowed by policy, but an owner must approve this exact transaction in the app.';
    case 'T3_DENY':
      return 'T3 (refused): outside the policy. Nobody can approve it; only a different request can succeed.';
  }
}

const RANK: Record<Tier, number> = { T1_AUTO: 0, T2_CONFIRM: 1, T3_DENY: 2 };

/** Strip trailing zeros so "0.005000" reads as "0.005". */
function tidy(v: bigint, decimals: number): string {
  const s = formatUnits(v, decimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function compliantAlternative(
  intent: Intent,
  policy: Policy,
  state: SpendState,
  chainId: number,
): Alternative | undefined {
  const original = evaluate(intent, policy, state, chainId);
  if (original.tier === 'T1_AUTO') return undefined;
  if (intent.kind !== 'native_transfer' && intent.kind !== 'erc20_transfer') {
    return original.tier === 'T3_DENY' ? { kind: 'none', note: 'Only transfers get an automatic alternative amount.' } : undefined;
  }

  const asset =
    intent.kind === 'native_transfer'
      ? { symbol: policy.native.symbol, decimals: 18, limits: policy.native as { autoMaxPerTx: string; hardMaxPerTx: string; dailyBudget: string } }
      : (() => {
          const t = tokenInfo(policy, intent.token);
          return t ? { symbol: t.symbol, decimals: t.decimals, limits: t } : undefined;
        })();
  if (!asset) return { kind: 'none', note: `Token ${'token' in intent ? intent.token : ''} is not in the policy.` };

  let amount: bigint;
  try {
    amount = parseUnits(intent.amount, asset.decimals);
  } catch {
    return { kind: 'none', note: 'The amount is not a valid number.' };
  }

  const { symbol, decimals } = asset;
  const hardMax = parseUnits(asset.limits.hardMaxPerTx, decimals);
  const autoMax = parseUnits(asset.limits.autoMaxPerTx, decimals);
  const budget = parseUnits(asset.limits.dailyBudget, decimals);
  const spent = state.spentToday[symbol] ?? 0n;

  // Every amount ceiling the policy imposes, in base units.
  const ceilings: bigint[] = [hardMax, budget - spent];
  if (state.envelope && state.envelope.asset === symbol) ceilings.push(state.envelope.budgetBase - state.envelope.spentBase);
  const v = policy.rateLimit.velocity;
  if (v && state.velocity && v.maxSpendPct < 100) {
    const cap = (budget * BigInt(Math.round(v.maxSpendPct * 100))) / 10_000n;
    ceilings.push(cap - (state.velocity.spentInWindow[symbol] ?? 0n));
  }
  const pct = policy.risk?.maxActionPctOfPortfolio ?? 0;
  const usd = state.risk;
  if (pct > 0 && usd?.portfolioUsd && usd.amountUsd && usd.amountUsd > 0n) {
    ceilings.push((amount * usd.portfolioUsd * BigInt(Math.round(pct * 100))) / (usd.amountUsd * 10_000n));
  }
  const maxOk = ceilings.reduce((a, b) => (b < a ? b : a));

  const target = getAddress(intent.to);
  const known = Object.values(policy.recipients.allowlist).includes(target);
  // T2 only because of the amount: the auto limit is the T1 alternative.
  const wanted = original.tier === 'T2_CONFIRM' ? (autoMax < maxOk ? autoMax : maxOk) : maxOk;

  if (wanted <= 0n) {
    return {
      kind: 'none',
      note:
        spent >= budget
          ? `Today's ${symbol} budget is used up (${tidy(spent, decimals)} of ${tidy(budget, decimals)}). It resets at 00:00 UTC.`
          : `No ${symbol} amount fits the policy right now.`,
    };
  }
  if (original.tier === 'T2_CONFIRM' && !known) {
    return undefined; // a new recipient needs one approval whatever the amount
  }
  if (wanted >= amount) {
    // The amount is not the problem (denylist, block list, lookalike, pause, rate limit...).
    return original.tier === 'T3_DENY'
      ? { kind: 'none', note: 'The refusal is not about the amount, so a smaller amount would be refused too.' }
      : undefined;
  }

  const candidate: Intent = { ...intent, amount: tidy(wanted, decimals) };
  // The USD value of the request scales with the amount.
  const scaled: SpendState =
    usd?.amountUsd && amount > 0n ? { ...state, risk: { ...usd, amountUsd: (usd.amountUsd * wanted) / amount } } : state;
  const decision = evaluate(candidate, policy, scaled, chainId);
  if (RANK[decision.tier] >= RANK[original.tier]) return undefined;

  const verb = decision.tier === 'T1_AUTO' ? 'executes automatically' : 'is allowed with an owner approval';
  return {
    kind: 'amount',
    intent: candidate,
    decision,
    note: `${tidy(wanted, decimals)} ${symbol} to the same recipient ${verb} (${explainTier(decision.tier).split(':')[0]}).`,
  };
}
