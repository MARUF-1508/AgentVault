import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import type { AuditEntry, AuditLog } from '../src/audit/log.js';
import type { Clients } from '../src/chain/client.js';
import type { ExecutionResult } from '../src/executor/executor.js';
import { PolicySchema, type Intent } from '../src/policy/types.js';
import { dueRules, SchedulesSchema, type Schedules } from '../src/schedule/rules.js';
import { firedTodayFrom, resolveIntent, runDueRules, type ScheduleDeps } from '../src/schedule/runner.js';

const ALICE = '0x4785Dca37A242F3D80f844CB0b143A687008a2B5';

const policy = PolicySchema.parse({
  version: 1,
  chainId: 84532,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: {
    USDC: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, autoMaxPerTx: '1', hardMaxPerTx: '10', dailyBudget: '25' },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  },
  recipients: { allowlist: { alice: ALICE }, denylist: [] },
  approvals: { allowUnlimited: false, spenderAllowlist: {} },
  swap: { router: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4', quoter: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27', feeTier: 3000, maxSlippageBps: 100, autoMaxSlippageBps: 50 },
  prices: { ETH: { fallbackUsd: '2500' } },
  rateLimit: { maxTxPerHour: 10 },
});

const schedules: Schedules = SchedulesSchema.parse({
  version: 1,
  rules: [
    { id: 'weekly', enabled: true, trigger: { kind: 'weekly', weekday: 5, atTimeUtc: '09:00' }, action: { kind: 'erc20_transfer', token: 'USDC', to: ALICE, amount: '1' } },
    { id: 'dip', enabled: true, trigger: { kind: 'price-drop', asset: 'ETH', dropPct: '5', baselineUsd: '2500' }, action: { kind: 'native_transfer', to: ALICE, amountPct: '50' } },
    { id: 'off', enabled: false, trigger: { kind: 'weekly', weekday: 5, atTimeUtc: '09:00' }, action: { kind: 'erc20_transfer', token: 'USDC', to: ALICE, amount: '1' } },
  ],
});

const none = new Set<string>();

describe('schedule rules (pure)', () => {
  it('fires a weekly rule only on the right day, at or after the time', () => {
    const friday = new Date('2026-10-16T09:30:00Z'); // Fri 16 Oct 2026, 09:30 UTC
    expect(dueRules(schedules, { now: friday, firedToday: none, prices: {} }).map((r) => r.id)).toEqual(['weekly']);

    const tooEarly = new Date('2026-10-16T08:30:00Z');
    expect(dueRules(schedules, { now: tooEarly, firedToday: none, prices: {} })).toHaveLength(0);

    const saturday = new Date('2026-10-17T09:30:00Z');
    expect(dueRules(schedules, { now: saturday, firedToday: none, prices: {} })).toHaveLength(0);
  });

  it('fires a price-drop rule only once the price is below the threshold', () => {
    const now = new Date('2026-10-14T12:00:00Z'); // Wednesday, so the weekly rule is quiet
    expect(dueRules(schedules, { now, firedToday: none, prices: { ETH: '2374' } }).map((r) => r.id)).toContain('dip');
    expect(dueRules(schedules, { now, firedToday: none, prices: { ETH: '2376' } })).toHaveLength(0);
    expect(dueRules(schedules, { now, firedToday: none, prices: {} })).toHaveLength(0); // no price yet
  });

  it('skips a rule that already fired today', () => {
    const friday = new Date('2026-10-16T09:30:00Z');
    expect(dueRules(schedules, { now: friday, firedToday: new Set(['weekly']), prices: {} })).toHaveLength(0);
  });
});

describe('schedule runner', () => {
  function deps(executed: Intent[], entries: AuditEntry[], balanceOf = 10_000_000n, override?: Schedules): { deps: ScheduleDeps; appended: Array<{ type: string; data: Record<string, unknown> }> } {
    const appended: Array<{ type: string; data: Record<string, unknown> }> = [];
    const clients = {
      publicClient: {
        getBalance: async () => parseEther('1'),
        readContract: async ({ functionName }: { functionName: string }) => (functionName === 'balanceOf' ? balanceOf : 0n),
      },
      account: { address: ALICE },
      chain: { id: 84532, name: 'Base Sepolia' },
    } as unknown as Clients;
    const executor = {
      execute: async (intent: Intent): Promise<ExecutionResult> => {
        executed.push(intent);
        return { status: 'executed', decision: { tier: 'T1_AUTO', reasons: [], amountBase: 0n, asset: 'USDC' }, txHash: '0xdead' };
      },
    } as unknown as ScheduleDeps['executor'];
    const audit = {
      read: () => entries,
      append: (type: string, data: Record<string, unknown>) => appended.push({ type, data }),
    } as unknown as AuditLog;
    return { deps: { clients, policy, executor, audit, schedules: override ?? schedules }, appended };
  }

  it('runs a due rule through the executor and logs a schedule entry', async () => {
    const executed: Intent[] = [];
    const { deps: d, appended } = deps(executed, []);
    const results = await runDueRules(d, { now: new Date('2026-10-16T09:30:00Z') });

    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ kind: 'erc20_transfer', token: 'USDC', amount: '1' });
    expect(results[0]).toMatchObject({ ruleId: 'weekly', status: 'executed', txHash: '0xdead' });
    expect(appended[0]).toMatchObject({ type: 'schedule', data: { ruleId: 'weekly' } });
  });

  it('does not re-run a rule that fired earlier today', async () => {
    const executed: Intent[] = [];
    const fired: AuditEntry = { seq: 0, ts: '2026-10-16T09:05:00.000Z', type: 'schedule', data: { ruleId: 'weekly' }, prevHash: '', hash: '' };
    const { deps: d } = deps(executed, [fired]);
    await runDueRules(d, { now: new Date('2026-10-16T09:30:00Z') });
    expect(executed).toHaveLength(0);
  });

  it('does not consume a rule on a dry run', async () => {
    const executed: Intent[] = [];
    const { deps: d, appended } = deps(executed, []);
    const results = await runDueRules(d, { now: new Date('2026-10-16T09:30:00Z'), dryRun: true });
    expect(executed).toHaveLength(1);
    expect(appended).toHaveLength(0); // nothing marked as fired, so the real run still happens
    expect(results).toHaveLength(1);
  });

  it('does not consume a rule when a dry run fails to resolve', async () => {
    // A rule with no recipient fails resolution; even so, a dry run must not record it.
    const bad = SchedulesSchema.parse({
      version: 1,
      rules: [{ id: 'bad', enabled: true, trigger: { kind: 'weekly', weekday: 5, atTimeUtc: '09:00' }, action: { kind: 'native_transfer', amount: '1' } }],
    });
    const executed: Intent[] = [];
    const { deps: d, appended } = deps(executed, [], 10_000_000n, bad);
    const results = await runDueRules(d, { now: new Date('2026-10-16T09:30:00Z'), dryRun: true });
    expect(results[0]).toMatchObject({ ruleId: 'bad', status: 'skipped' });
    expect(appended).toHaveLength(0);
  });

  it('resolves amountPct against the current balance', async () => {
    const { deps: d } = deps([], [], 10_000_000n); // 10 USDC
    const intent = await resolveIntent({ kind: 'erc20_transfer', token: 'USDC', to: ALICE, amountPct: '50' }, d);
    expect(intent).toMatchObject({ kind: 'erc20_transfer', amount: '5' });
  });
});

describe('firedTodayFrom', () => {
  it('collects rule ids from schedule entries today, ignoring older days', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    const entries = [
      { seq: 0, ts: '2026-10-15T09:05:00.000Z', type: 'schedule', data: { ruleId: 'yesterday' }, prevHash: '', hash: '' },
      { seq: 1, ts: '2026-10-16T09:05:00.000Z', type: 'schedule', data: { ruleId: 'today' }, prevHash: '', hash: '' },
      { seq: 2, ts: '2026-10-16T09:06:00.000Z', type: 'tx_sent', data: {}, prevHash: '', hash: '' },
    ] as AuditEntry[];
    expect([...firedTodayFrom(entries, now)]).toEqual(['today']);
  });
});
