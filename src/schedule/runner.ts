import { erc20Abi, formatUnits, parseUnits } from 'viem';
import type { AuditEntry, AuditLog } from '../audit/log.js';
import type { Clients } from '../chain/client.js';
import type { Executor } from '../executor/executor.js';
import { tokenInfo } from '../policy/engine.js';
import { IntentSchema, type Intent, type Policy } from '../policy/types.js';
import { getUsdPrice } from '../prices/price.js';
import { dueRules, type ScheduleAction, type Schedules } from './rules.js';

export interface ScheduleDeps {
  clients: Clients;
  policy: Policy;
  executor: Executor;
  audit: AuditLog;
  schedules: Schedules;
}

export interface RunResult {
  ruleId: string;
  status: string;
  txHash?: string;
  error?: string;
}

/**
 * Run every due rule once, each through the Executor (so it is policy-checked,
 * simulated and logged like any other action). A rule that already fired today
 * (per the audit log) is skipped, so re-running is safe.
 */
export async function runDueRules(deps: ScheduleDeps, opts: { now?: Date; dryRun?: boolean } = {}): Promise<RunResult[]> {
  const now = opts.now ?? new Date();
  const entries = deps.audit.read();
  const firedToday = firedTodayFrom(entries, now);
  const prices = await currentPrices(deps);

  const due = dueRules(deps.schedules, { now, firedToday, prices });
  const results: RunResult[] = [];
  for (const rule of due) {
    try {
      const intent = await resolveIntent(rule.action, deps);
      const r = await deps.executor.execute(intent, { dryRun: opts.dryRun });
      // A dry run must not consume the rule for the day, so only real runs are recorded.
      if (!opts.dryRun) deps.audit.append('schedule', { ruleId: rule.id, status: r.status, txHash: r.txHash, error: r.error });
      results.push({ ruleId: rule.id, status: r.status, txHash: r.txHash, error: r.error });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // As above: a dry run must not consume the rule, even when resolution fails.
      if (!opts.dryRun) deps.audit.append('schedule', { ruleId: rule.id, status: 'skipped', error });
      results.push({ ruleId: rule.id, status: 'skipped', error });
    }
  }
  return results;
}

/** Rule ids that already produced a `schedule` entry today (UTC). */
export function firedTodayFrom(entries: AuditEntry[], now: Date): Set<string> {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.type !== 'schedule') continue;
    if (Date.parse(e.ts) >= dayStart && typeof e.data.ruleId === 'string') ids.add(e.data.ruleId);
  }
  return ids;
}

async function currentPrices(deps: ScheduleDeps): Promise<Record<string, string>> {
  const assets = new Set(
    deps.schedules.rules.filter((r) => r.trigger.kind === 'price-drop').map((r) => (r.trigger as { asset: string }).asset),
  );
  const prices: Record<string, string> = {};
  for (const asset of assets) {
    const q = await getUsdPrice(deps.clients.publicClient, deps.policy, asset);
    if (q) prices[asset] = q.usdPrice;
  }
  return prices;
}

/** Turn a rule action (which may be a percentage) into a concrete, validated Intent. */
export async function resolveIntent(action: ScheduleAction, deps: ScheduleDeps): Promise<Intent> {
  if (action.kind === 'swap') {
    if (!action.tokenIn || !action.tokenOut) throw new Error('swap action needs tokenIn and tokenOut');
    const slippageBps = action.slippageBps ?? deps.policy.swap?.autoMaxSlippageBps;
    if (slippageBps === undefined) throw new Error('swap action needs slippageBps (no policy swap config)');
    const amountIn = await amountFor(action, deps, action.tokenIn);
    return IntentSchema.parse({ kind: 'swap', tokenIn: action.tokenIn, tokenOut: action.tokenOut, amountIn, slippageBps });
  }
  if (!action.to) throw new Error(`${action.kind} action needs a recipient`);
  if (action.kind === 'native_transfer') {
    const amount = await amountFor(action, deps, deps.policy.native.symbol);
    return IntentSchema.parse({ kind: 'native_transfer', to: action.to, amount });
  }
  if (!action.token) throw new Error('erc20_transfer action needs a token');
  const amount = await amountFor(action, deps, action.token);
  return IntentSchema.parse({ kind: 'erc20_transfer', token: action.token, to: action.to, amount });
}

/** Fixed amount, or `amountPct` of the current balance of `symbol` (rounded down). */
async function amountFor(action: ScheduleAction, deps: ScheduleDeps, symbol: string): Promise<string> {
  if (action.amount !== undefined) return action.amount;
  if (action.amountPct === undefined) throw new Error('action needs amount or amountPct');

  const { publicClient, account } = deps.clients;
  if (!account) throw new Error('cannot resolve a percentage without a wallet key');
  const decimals = symbol === deps.policy.native.symbol ? 18 : (tokenInfo(deps.policy, symbol)?.decimals ?? 0);
  const balance =
    symbol === deps.policy.native.symbol
      ? await publicClient.getBalance({ address: account.address })
      : await publicClient.readContract({
          address: tokenInfo(deps.policy, symbol)!.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [account.address],
        });

  const pct = parseUnits(action.amountPct, 8);
  const base = (balance * pct) / (100n * 10n ** 8n);
  return formatUnits(base, decimals);
}
