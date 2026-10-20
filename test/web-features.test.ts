import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebApprover } from '../src/approval/approver.js';
import type { ToolContext } from '../src/agent/tools.js';
import { UserStore } from '../src/auth/users.js';
import type { Env } from '../src/config.js';
import { createServer } from '../src/web/server.js';
import { ALICE, basePolicy, harness } from './helpers.js';

describe('web features that used to be CLI-only', () => {
  let server: Server;
  let base = '';
  let owner = '';
  let viewer = '';
  const dir = mkdtempSync(join(tmpdir(), 'av-web3-'));
  const policyFile = join(dir, 'policy.json');
  const schedulesFile = join(dir, 'schedules.json');
  const envFile = join(dir, '.env');
  const h = harness();
  writeFileSync(policyFile, `${JSON.stringify(basePolicy(), null, 2)}\n`);
  const tomorrow = (new Date().getUTCDay() + 1) % 7;
  writeFileSync(
    schedulesFile,
    JSON.stringify({
      version: 1,
      rules: [
        {
          id: 'not-today',
          enabled: true,
          trigger: { kind: 'weekly', weekday: tomorrow, atTimeUtc: '23:59' },
          action: { kind: 'native_transfer', to: ALICE, amount: '0.0002' },
        },
      ],
    }),
  );
  const env = {
    POLICY_FILE: policyFile,
    PAUSE_FILE: join(dir, 'PAUSED'),
    ENV_FILE: envFile,
    SCHEDULES_FILE: schedulesFile,
    LLM_MODEL: 'x',
  } as Env;
  const users = new UserStore(join(dir, 'users.json'));
  const pw = { owner: users.add('olivia', 'owner'), viewer: users.add('vera', 'viewer') };

  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const login = async (username: string, password: string) =>
    ((await call('/api/auth/login', { body: { username, password } })).headers.get('set-cookie') ?? '').split(';')[0]!;

  beforeAll(async () => {
    const ctx: ToolContext = { clients: h.clients, policy: h.policy, executor: h.executor, audit: h.audit };
    server = createServer({
      env,
      ctx,
      approver: new WebApprover(),
      users,
      distDir: '/nonexistent-dist',
      rateLimits: { preview: { max: 100, windowMs: 60_000 }, transact: { max: 100, windowMs: 60_000 } },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    owner = await login('olivia', pw.owner);
    viewer = await login('vera', pw.viewer);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('pauses and resumes, but resuming needs the password and an owner', async () => {
    expect((await call('/api/pause', { cookie: owner, body: {} })).status).toBe(200);
    expect((await (await call('/api/budget', { cookie: owner })).json()).paused).toBe(true);
    expect((await call('/api/resume', { cookie: viewer, body: { password: pw.viewer } })).status).toBe(403);
    expect((await call('/api/resume', { cookie: owner, body: { password: 'wrong-password' } })).status).toBe(401);
    const ok = await call('/api/resume', { cookie: owner, body: { password: pw.owner } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ paused: false });
    const budget = await (await call('/api/budget', { cookie: owner })).json();
    expect(budget.paused).toBe(false);
    const audit = h.audit.read();
    expect(audit.at(-1)).toMatchObject({ type: 'kill_switch', data: { paused: false, by: 'web', user: 'olivia' } });
  });

  it('generates a wallet only for an owner who confirms the password, and never returns the key', async () => {
    expect((await call('/api/wallet/generate', { cookie: viewer, body: { password: pw.viewer, confirm: 'new-wallet' } })).status).toBe(403);
    expect((await call('/api/wallet/generate', { cookie: owner, body: { password: pw.owner } })).status).toBe(400);
    expect((await call('/api/wallet/generate', { cookie: owner, body: { password: 'wrong', confirm: 'new-wallet' } })).status).toBe(401);
    const r = await call('/api/wallet/generate', { cookie: owner, body: { password: pw.owner, confirm: 'new-wallet' } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ previous: null, restartRequired: true });
    expect(body.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(JSON.stringify(body)).not.toMatch(/0x[0-9a-f]{64}/);
    const env = readFileSync(envFile, 'utf8');
    expect(env).toMatch(/AGENT_PRIVATE_KEY=0x[0-9a-f]{64}/);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(h.audit.read().at(-1)).toMatchObject({ type: 'access', data: { event: 'wallet_generated', by: 'olivia', address: body.address } });
  });

  it('lists schedules and can run them (dry) through the shared runner', async () => {
    const list = await call('/api/schedules', { cookie: viewer });
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0].id).toBe('not-today');
    expect((await call('/api/schedules/run', { cookie: viewer, body: { dryRun: true } })).status).toBe(403);
    const run = await call('/api/schedules/run', { cookie: owner, body: { dryRun: true } });
    expect(run.status).toBe(200);
    expect(await run.json()).toEqual({ ran: 0, results: [] });
  });

  it('answers what-if questions read-only and validates input', async () => {
    const bad = await call('/api/whatif', { cookie: owner, body: { to: 'nope', amount: '1' } });
    expect(bad.status).toBe(400);
    expect((await call('/api/whatif', { cookie: viewer, body: { to: ALICE, amount: '0.0002' } })).status).toBe(403);
    const r = await call('/api/whatif', { cookie: owner, body: { to: ALICE, amount: '0.0002', allow: true } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.baseline.tier).toBe('T1_AUTO');
    expect(body.hypothetical.tier).toBe('T1_AUTO');
    expect(typeof body.summary).toBe('string');
  });

  it('anchors the audit head and reports on-chain verification', async () => {
    expect((await call('/api/audit/anchor', { cookie: viewer, body: {} })).status).toBe(403);
    const r = await call('/api/audit/anchor', { cookie: owner, body: {} });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('executed');
    expect(body.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.anchoredSeq).toBeGreaterThan(0);
    const last = h.audit.read().at(-1)!;
    expect(last).toMatchObject({ type: 'anchor', data: { seq: body.anchoredSeq, txHash: body.txHash } });
    const check = await call('/api/audit/anchors', { cookie: viewer });
    expect(check.status).toBe(200);
    const report = await check.json();
    expect(report.local.ok).toBe(true);
    expect(report.onchain.checks).toHaveLength(1);
  });

  it('exposes swap quote/execute and the x402 fetch only when configured', async () => {
    expect((await call('/api/swap', { cookie: viewer, body: { tokenIn: 'A', tokenOut: 'B', amountIn: '1' } })).status).toBe(403);
    const quote = await call('/api/swap/quote', { cookie: owner, body: { tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '1' } });
    expect(quote.status).toBe(200);
    expect(await quote.json()).toMatchObject({ error: 'Swaps are not enabled in the policy.' });
    const swap = await call('/api/swap', { cookie: owner, body: { tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '1' } });
    expect(swap.status).toBe(400);
    const pay = await call('/api/x402', { cookie: owner, body: {} });
    expect(pay.status).toBe(400);
    expect(await pay.json()).toMatchObject({ error: expect.stringContaining('not configured') });
  });
});
