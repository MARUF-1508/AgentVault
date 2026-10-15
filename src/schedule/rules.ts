import { readFileSync } from 'node:fs';
import { parseUnits } from 'viem';
import { z } from 'zod';

/**
 * Scheduled / conditional actions. Rules are user configuration (never something
 * the LLM can write); each time one fires it is turned into a normal Intent and
 * run through the same Executor, so the policy firewall still decides.
 */

const Decimal = z.string().regex(/^\d+(\.\d+)?$/, 'decimal string, e.g. "1" or "5"');
const TimeUtc = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM in UTC');

const Trigger = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('weekly'),
    // 0 = Sunday … 6 = Saturday (UTC), like Date.getUTCDay()
    weekday: z.number().int().min(0).max(6),
    atTimeUtc: TimeUtc,
  }),
  z.object({
    kind: z.literal('price-drop'),
    /** Asset symbol from the policy, e.g. ETH. */
    asset: z.string().min(1),
    /** Fire when the price is at least this far below the recorded baseline. */
    dropPct: Decimal,
    /** USD price recorded when the rule was written. */
    baselineUsd: Decimal,
  }),
]);

const Action = z
  .object({
    kind: z.enum(['native_transfer', 'erc20_transfer', 'swap']),
    // transfers
    token: z.string().optional(),
    to: z.string().optional(),
    // swaps
    tokenIn: z.string().optional(),
    tokenOut: z.string().optional(),
    slippageBps: z.number().int().min(0).max(10_000).optional(),
    // amount: exactly one of a fixed amount or a percentage of the source balance
    amount: Decimal.optional(),
    amountPct: Decimal.optional(),
  })
  .refine((a) => (a.amount === undefined) !== (a.amountPct === undefined), {
    message: 'exactly one of amount or amountPct must be set',
  });

const Rule = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  trigger: Trigger,
  action: Action,
});

export const SchedulesSchema = z.object({
  version: z.literal(1),
  rules: z.array(Rule),
});

export type Schedules = z.infer<typeof SchedulesSchema>;
export type ScheduleRule = Schedules['rules'][number];
export type ScheduleAction = ScheduleRule['action'];

export function loadSchedules(path: string): Schedules {
  return SchedulesSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export interface DueContext {
  now: Date;
  /** rule ids that already fired today (UTC), derived from the audit log. */
  firedToday: ReadonlySet<string>;
  /** current USD prices by asset symbol, as decimal strings. */
  prices: Record<string, string>;
}

/** Pure: which rules are due right now and have not already fired today. */
export function dueRules(schedules: Schedules, ctx: DueContext): ScheduleRule[] {
  return schedules.rules.filter((r) => r.enabled && !ctx.firedToday.has(r.id) && isDue(r, ctx));
}

function isDue(rule: ScheduleRule, ctx: DueContext): boolean {
  return rule.trigger.kind === 'weekly'
    ? weeklyDue(rule.trigger, ctx.now)
    : priceDropDue(rule.trigger, ctx.prices[rule.trigger.asset]);
}

function weeklyDue(t: Extract<ScheduleRule['trigger'], { kind: 'weekly' }>, now: Date): boolean {
  if (now.getUTCDay() !== t.weekday) return false;
  const [h, m] = t.atTimeUtc.split(':').map(Number) as [number, number];
  return now.getUTCHours() * 60 + now.getUTCMinutes() >= h * 60 + m;
}

function priceDropDue(t: Extract<ScheduleRule['trigger'], { kind: 'price-drop' }>, currentUsd?: string): boolean {
  if (!currentUsd) return false;
  const scale = 8;
  const unit = 10n ** BigInt(scale);
  const base = parseUnits(t.baselineUsd, scale);
  const current = parseUnits(currentUsd, scale);
  const drop = parseUnits(t.dropPct, scale);
  if (base <= 0n) return false;
  const cut = (base * drop) / (100n * unit);
  return current <= base - cut;
}
