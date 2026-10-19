import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { BOB, harness } from './helpers.js';

describe('web routes added for the final upgrade', () => {
  let server: Server;
  let base = '';
  let owner = '';
  let viewer = '';
  const dir = mkdtempSync(join(tmpdir(), 'av-web2-'));
  const policyFile = join(dir, 'policy.json');
  const h = harness();
  writeFileSync(policyFile, `${JSON.stringify(h.policy, null, 2)}\n`);
  const env = { POLICY_FILE: policyFile, PAUSE_FILE: join(dir, 'PAUSED'), LLM_MODEL: 'x' } as Env;
  const users = new UserStore(join(dir, 'users.json'));
  const pw = { owner: users.add('olivia', 'owner'), viewer: users.add('vera', 'viewer') };

  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
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
      rateLimits: { preview: { max: 3, windowMs: 60_000 } },
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

  it('/api/health is public, cheap and leaks nothing sensitive', async () => {
    const r = await call('/api/health');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, status: 'ok', chainId: 84532, rpc: { ok: true, blockNumber: '105' }, auditIntact: true });
    expect(JSON.stringify(body)).not.toMatch(/0x1111/); // no wallet address
  });

  it('refuses a request a browser marks as cross-site, and sets a permissions policy', async () => {
    const r = await call('/api/status', { cookie: owner, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(r.status).toBe(403);
    const ok = await call('/api/status', { cookie: owner, headers: { 'sec-fetch-site': 'same-origin' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('permissions-policy')).toMatch(/microphone=\(self\)/);
    expect(await ok.json()).toMatchObject({ policyIntegrity: { drift: false }, pendingTxs: 0 });
  });

  it('previews a batch with each line counted toward the next, and a viewer cannot send one', async () => {
    const r = await call('/api/batch/preview', {
      cookie: owner,
      body: { transfers: [{ to: 'alice', amount: '0.004' }, { to: 'alice', amount: '0.004' }, { to: 'alice', amount: '0.004' }] },
    });
    expect(await r.json()).toMatchObject({ allowed: false, lines: [{ tier: 'T2_CONFIRM' }, { tier: 'T2_CONFIRM' }, { tier: 'T3_DENY' }] });
    expect((await call('/api/batch', { cookie: viewer, body: { transfers: [] } })).status).toBe(403);
    expect((await call('/api/batch/preview', { cookie: owner, body: { transfers: [{ to: 'nobody', amount: '1' }] } })).status).toBe(400);
  });

  it('preview returns the tier explanation and the engine alternative', async () => {
    const r = await call('/api/preview', { cookie: owner, body: { intent: { kind: 'native_transfer', to: BOB, amount: '1' } } });
    expect(await r.json()).toMatchObject({ tier: 'T3_DENY', explanation: expect.any(String), alternative: { available: true, intent: { amount: '0.005' } } });
  });

  it('rate-limits previews per user with Retry-After', async () => {
    // The preview bucket allows 3 per minute in this server; one was used by the test above.
    const body = { intent: { kind: 'native_transfer', to: BOB, amount: '0.0001' } };
    await call('/api/preview', { cookie: owner, body });
    await call('/api/preview', { cookie: owner, body });
    const limited = await call('/api/preview', { cookie: owner, body });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('tracks a transaction by hash, and validates the hash', async () => {
    const sent = await h.executor.execute({ kind: 'native_transfer', to: '0x4785Dca37A242F3D80f844CB0b143A687008a2B5', amount: '0.0001' });
    expect((await call(`/api/tx?hash=${sent.txHash}`, { cookie: viewer })).status).toBe(200);
    expect(await (await call(`/api/tx?hash=${sent.txHash}`, { cookie: viewer })).json()).toMatchObject({ status: 'confirmed' });
    expect((await call('/api/tx?hash=0x12', { cookie: viewer })).status).toBe(400);
    expect(await (await call('/api/tx/pending', { cookie: viewer })).json()).toEqual({ pending: [] });
  });

  it('lets only an owner edit the address book, audited, and the file stays loadable', async () => {
    expect((await call('/api/policy/contacts/add', { cookie: viewer, body: { label: 'bob', address: BOB } })).status).toBe(403);
    const r = await call('/api/policy/contacts/add', { cookie: owner, body: { label: 'bob', address: BOB } });
    expect(r.status).toBe(200);
    expect((await r.json()).contacts).toEqual({ bob: BOB });
    expect(h.audit.read().some((e) => e.type === 'access' && e.data.event === 'contact_added')).toBe(true);
    // The server accepted its own write: no drift reported.
    expect((await (await call('/api/status', { cookie: owner })).json()).policyIntegrity.drift).toBe(false);
    expect((await call('/api/policy/contacts/remove', { cookie: owner, body: { label: 'bob' } })).status).toBe(200);
  });

  it('exports a compliance report as a download', async () => {
    const r = await call('/api/compliance', { cookie: viewer });
    expect(r.headers.get('content-disposition')).toMatch(/agentvault-compliance\.json/);
    const report = await r.json();
    expect(report).toMatchObject({ chain: { id: 84532 }, integrity: { ok: true } });
    expect(report.totals.transactions.sent).toBeGreaterThan(0);
    expect((await call('/api/compliance?from=yesterday', { cookie: viewer })).status).toBe(400);
  });
});
