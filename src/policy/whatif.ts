import { getAddress } from 'viem';
import { evaluate } from './engine.js';
import type { Decision, Intent, Policy, SpendState, SwapMarket } from './types.js';

/**
 * Counterfactual policy checks: "what would happen if ...?". Pure, like the
 * engine it wraps — it evaluates the same intent twice, once as things are and
 * once with a hypothetical policy/state, and reports what changed. It cannot
 * change anything: the only inputs are values, the only output is a comparison.
 * That makes it safe to expose to a model or a human as read-only advice.
 */

/** The changes to assume for the hypothetical run. All optional. */
export interface WhatIfHypothesis {
  /** Extra amount already spent today, base units per asset symbol. */
  spentToday?: Record<string, bigint>;
  /** Addresses to treat as already-allowlisted (known recipients). */
  allowRecipients?: `0x${string}`[];
  /** Per-transaction limits to assume, human-readable, for the intent's asset. */
  limits?: { autoMaxPerTx?: string; hardMaxPerTx?: string; dailyBudget?: string };
  /** Assume the kill switch is on (or off). */
  paused?: boolean;
  /** Evaluate against a different chain id (e.g. to show the chain guard). */
  chainId?: number;
}

export interface WhatIfResult {
  /** The decision as the wallet stands today. */
  baseline: Decision;
  /** The decision under the hypothesis. */
  hypothetical: Decision;
  /** True when the hypothesis relaxes the outcome (DENY → CONFIRM → AUTO). */
  morePermissive: boolean;
  /** One-line, human-readable summary of the change. */
  summary: string;
}

/** Least to most restrictive. */
const RANK: Record<Decision['tier'], number> = { T1_AUTO: 0, T2_CONFIRM: 1, T3_DENY: 2 };

/** The policy asset symbol an intent is priced in; null when it is not a token limit. */
function assetSymbol(intent: Intent, policy: Policy): string | null {
  switch (intent.kind) {
    case 'native_transfer':
      return policy.native.symbol;
    case 'erc20_transfer':
    case 'erc20_approve':
      return intent.token;
    case 'swap':
      // Swap limits come from the swap rules, not per-token limits.
      return null;
  }
}

/**
 * Evaluates `intent` twice: as things are, and under `hypothesis`. Purely.
 * `market` is the same quote the executor would pass, so swaps compare like
 * for like.
 */
export function whatIf(
  intent: Intent,
  policy: Policy,
  state: SpendState,
  chainId: number,
  hypothesis: WhatIfHypothesis = {},
  market?: SwapMarket,
): WhatIfResult {
  const baseline = evaluate(intent, policy, state, chainId, market);

  // A shallow copy is enough: we only replace the fields we touch.
  const next: Policy = { ...policy, recipients: { ...policy.recipients, allowlist: { ...policy.recipients.allowlist } } };
  for (const address of hypothesis.allowRecipients ?? []) {
    next.recipients.allowlist[`whatif:${address.toLowerCase()}`] = getAddress(address);
  }

  const symbol = assetSymbol(intent, policy);
  if (hypothesis.limits && symbol) {
    const merge = (limits: { autoMaxPerTx: string; hardMaxPerTx: string; dailyBudget: string }) => ({
      autoMaxPerTx: hypothesis.limits!.autoMaxPerTx ?? limits.autoMaxPerTx,
      hardMaxPerTx: hypothesis.limits!.hardMaxPerTx ?? limits.hardMaxPerTx,
      dailyBudget: hypothesis.limits!.dailyBudget ?? limits.dailyBudget,
    });
    if (symbol === policy.native.symbol) {
      next.native = { ...policy.native, ...merge(policy.native) };
    } else if (policy.tokens[symbol]) {
      next.tokens = { ...policy.tokens, [symbol]: { ...policy.tokens[symbol], ...merge(policy.tokens[symbol]) } };
    }
  }

  const nextState: SpendState = {
    ...state,
    paused: hypothesis.paused ?? state.paused,
    spentToday: { ...state.spentToday },
  };
  for (const [asset, extra] of Object.entries(hypothesis.spentToday ?? {})) {
    nextState.spentToday[asset] = (nextState.spentToday[asset] ?? 0n) + extra;
  }

  const hypothetical = evaluate(intent, next, nextState, hypothesis.chainId ?? chainId, market);
  const morePermissive = RANK[hypothetical.tier] < RANK[baseline.tier];
  return { baseline, hypothetical, morePermissive, summary: summarise(baseline, hypothetical) };
}

function summarise(baseline: Decision, hypothetical: Decision): string {
  if (hypothetical.tier === baseline.tier) return `No change: still ${baseline.tier}.`;
  const arrow = `${baseline.tier} → ${hypothetical.tier}`;
  if (hypothetical.tier === 'T3_DENY') return `${arrow}: it would be refused (${hypothetical.reasons.join(' ')}).`;
  if (baseline.tier === 'T3_DENY') return `${arrow}: it would go through (${hypothetical.reasons.join(' ')}).`;
  return `${arrow}: ${hypothetical.reasons.join(' ')}`;
}
