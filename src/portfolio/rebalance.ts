import { formatUnits, parseUnits } from 'viem';
import { tokenInfo } from '../policy/engine.js';
import type { Policy } from '../policy/types.js';
import { USD_SCALE } from '../prices/price.js';
import type { Holding } from './portfolio.js';

/**
 * Portfolio rebalancing (T6). Pure planner: given the current holdings and a
 * target allocation (percent per token), it proposes the swaps that move the
 * portfolio toward the target. It never signs anything. Each proposed swap is a
 * normal `execute_swap`, so the policy engine (limits, budget, slippage, the
 * allowlisted router) still decides every step, and a T2 step still needs a human.
 *
 * Only policy tokens that the router can swap are rebalanced. The native coin
 * is left alone (it pays for gas and the router swaps tokens, not ETH).
 */
export interface RebalanceStep {
  tokenIn: string;
  tokenOut: string;
  /** Human-readable amount of tokenIn to sell. */
  amountIn: string;
  /** Approximate USD value moved, 2 decimals. */
  usd: string;
}

export interface RebalancePlan {
  totalUsd: string;
  current: Record<string, string>;
  target: Record<string, number>;
  steps: RebalanceStep[];
  note: string;
}

export function planRebalance(
  holdings: Holding[],
  target: Record<string, number>,
  policy: Policy,
  opts: { minTradeUsd?: string } = {},
): RebalancePlan | { error: string } {
  if (!policy.swap) return { error: 'Swaps are not enabled in the policy, so there is nothing to rebalance with.' };
  const symbols = Object.keys(target);
  if (symbols.length < 2) return { error: 'Give at least two tokens with target percentages.' };
  const sum = symbols.reduce((a, s) => a + (target[s] ?? 0), 0);
  if (symbols.some((s) => !Number.isFinite(target[s]) || target[s]! < 0) || Math.abs(sum - 100) > 0.01) {
    return { error: `Target percentages must be non-negative and add up to 100 (they add up to ${sum}).` };
  }

  // Value of each target token in USD (8 decimals).
  const value: Record<string, bigint> = {};
  const price: Record<string, bigint> = {};
  const canonical: Record<string, string> = {};
  for (const s of symbols) {
    const t = tokenInfo(policy, s);
    if (!t) return { error: `${s} is not a policy token (only tokens can be rebalanced, not ${policy.native.symbol}).` };
    canonical[s] = t.symbol;
    const h = holdings.find((x) => x.asset.toLowerCase() === t.symbol.toLowerCase());
    if (!h || h.error || !h.usdPrice) return { error: `No balance or price for ${t.symbol}; cannot plan a rebalance.` };
    price[t.symbol] = parseUnits(h.usdPrice, USD_SCALE);
    value[t.symbol] = (parseUnits(h.balance, t.decimals) * price[t.symbol]!) / 10n ** BigInt(t.decimals);
  }
  const total = Object.values(value).reduce((a, b) => a + b, 0n);
  const fmtUsd = (v: bigint) => Number(formatUnits(v, USD_SCALE)).toFixed(2);
  const current = Object.fromEntries(
    Object.entries(value).map(([s, v]) => [s, total > 0n ? `${((Number(v) / Number(total)) * 100).toFixed(1)}%` : '0%']),
  );
  const targetOut = Object.fromEntries(symbols.map((s) => [canonical[s]!, target[s]!]));
  if (total === 0n) return { totalUsd: '0.00', current, target: targetOut, steps: [], note: 'Nothing to rebalance: the tokens are worth $0.' };

  const minTrade = parseUnits(opts.minTradeUsd ?? '1', USD_SCALE);
  // Basis-point targets keep the arithmetic in integers.
  const delta = symbols.map((s) => {
    const sym = canonical[s]!;
    const want = (total * BigInt(Math.round(target[s]! * 100))) / 10_000n;
    return { sym, diff: want - value[sym]! };
  });
  const sellers = delta.filter((d) => d.diff < -minTrade).map((d) => ({ sym: d.sym, usd: -d.diff }));
  const buyers = delta.filter((d) => d.diff > minTrade).map((d) => ({ sym: d.sym, usd: d.diff }));
  sellers.sort((a, b) => (b.usd > a.usd ? 1 : -1));
  buyers.sort((a, b) => (b.usd > a.usd ? 1 : -1));

  const steps: RebalanceStep[] = [];
  for (const seller of sellers) {
    for (const buyer of buyers) {
      if (seller.usd <= minTrade) break;
      if (buyer.usd <= minTrade) continue;
      const usd = seller.usd < buyer.usd ? seller.usd : buyer.usd;
      const t = tokenInfo(policy, seller.sym)!;
      const amountBase = (usd * 10n ** BigInt(t.decimals)) / price[seller.sym]!;
      if (amountBase <= 0n) continue;
      const amountIn = formatUnits(amountBase, t.decimals);
      steps.push({ tokenIn: seller.sym, tokenOut: buyer.sym, amountIn: trim(amountIn, t.decimals > 6 ? 6 : t.decimals), usd: fmtUsd(usd) });
      seller.usd -= usd;
      buyer.usd -= usd;
    }
  }
  return {
    totalUsd: fmtUsd(total),
    current,
    target: targetOut,
    steps,
    note: steps.length
      ? 'Each step is an execute_swap and goes through the policy engine; large steps may need an owner approval or be refused.'
      : 'Already within $' + fmtUsd(minTrade) + ' of the target; no swaps needed.',
  };
}

/** Round a decimal string down to `places` fractional digits (never up: we must not sell more than planned). */
function trim(v: string, places: number): string {
  const [i, f = ''] = v.split('.');
  const frac = f.slice(0, places).replace(/0+$/, '');
  return frac ? `${i}.${frac}` : i!;
}
