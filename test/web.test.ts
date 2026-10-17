import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebApprover } from '../src/approval/approver.js';
import type { AuditLog } from '../src/audit/log.js';
import type { ToolContext } from '../src/agent/tools.js';
import type { Env } from '../src/config.js';
import type { Executor } from '../src/executor/executor.js';
import { PolicySchema } from '../src/policy/types.js';
import { UserStore } from '../src/auth/users.js';
import { createServer, inlineScriptHashes } from '../src/web/server.js';
import { request, type Server } from 'node:http';

const policy = PolicySchema.parse({
  version: 1,
  chainId: 84532,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: {},
  recipients: { allowlist: {}, denylist: [] },
  approvals: { allowUnlimited: false, spenderAllowlist: {} },
  rateLimit: { maxTxPerHour: 5 },
});

const env = {
  CHAIN: 'base-sepolia',
  LLM_BASE_URL: 'https://api.openai.com/v1',
  LLM_MODEL: 'gpt-4o-mini',
  POLICY_FILE: 'config/policy.json',
  AUDIT_LOG: 'data/audit.jsonl',
  PAUSE_FILE: join(mkdtempSync(join(tmpdir(), 'aw-web-')), 'PAUSED'),
  ALLOW_MAINNET: 'false',
} as Env;

const appends: { type: string; data: Record<string, unknown> }[] = [];

function stubCtx(executor: Partial<Executor>): { ctx: ToolContext; approver: WebApprover } {
  const approver = new WebApprover();
  const audit = {
    read: () => [],
    verify: () => ({ ok: true }),
    append: (type: string, data: Record<string, unknown>) => {
      appends.push({ type, data });
      return {};
    },
  } as unknown as AuditLog;
  const clients = {
    chain: { id: 84532, name: 'Base Sepolia' },
    publicClient: {},
    account: { address: '0x1111111111111111111111111111111111111111' },
  } as unknown as ToolContext['clients'];
  const ctx = { clients, policy, executor: executor as Executor, audit } as ToolContext;
  return { ctx, approver };
}

const dir = mkdtempSync(join(tmpdir(), 'aw-users-'));
const users = new UserStore(join(dir, 'users.json'));
const PASSWORDS = { owner: users.add('olivia', 'owner'), operator: users.add('oscar', 'operator'), viewer: users.add('vera', 'viewer') };

/** Signs in and returns the session cookie. */
async function login(base: string, username: string, password: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
}

describe('web server', () => {
  let server: Server;
  let base = '';
  let cookie = '';
  /** fetch as the signed-in owner. */
  const authed = (url: string, init: RequestInit = {}) =>
    fetch(url, { ...init, headers: { cookie, ...(init.headers as Record<string, string> | undefined) } });

  beforeAll(async () => {
    const { ctx, approver } = stubCtx({
      preview: (async () => ({ tier: 'T2_CONFIRM', reasons: ['new recipient'], amountBase: 1n, asset: 'ETH' })) as never,
      execute: (async (intent: never) => {
        const decision = { tier: 'T2_CONFIRM' as const, reasons: ['new recipient'], amountBase: 1n, asset: 'ETH' };
        void intent;
        const ok = await approver.confirm('desc T2_CONFIRM');
        return ok
          ? { status: 'executed', decision, txHash: '0xabc' }
          : { status: 'rejected_by_human', decision };
      }) as never,
    });
    server = createServer({ env, ctx, approver, users, distDir: '/nonexistent-dist' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cookie = await login(base, 'olivia', PASSWORDS.owner);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(env.PAUSE_FILE, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('needs a session for every API route, and the cookie is HttpOnly and SameSite=Strict', async () => {
    for (const path of ['/api/status', '/api/pending', '/api/portfolio', '/api/stats', '/api/audit/export', '/api/auth/me']) {
      expect((await fetch(`${base}${path}`)).status).toBe(401);
    }
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'vera', password: PASSWORDS.viewer }),
    });
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
    expect(await r.json()).toEqual({ user: 'vera', role: 'viewer', permissions: ['read'] });
  });

  it('enforces roles: a viewer reads but cannot preview, transact, approve or pause', async () => {
    const viewer = await login(base, 'vera', PASSWORDS.viewer);
    const as = (path: string, method = 'GET', body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { cookie: viewer, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    expect((await as('/api/pending')).status).toBe(200);
    const intent = { kind: 'native_transfer', to: '0x2222222222222222222222222222222222222222', amount: '0.0005' };
    expect((await as('/api/preview', 'POST', { intent })).status).toBe(403);
    expect((await as('/api/transact', 'POST', { intent })).status).toBe(403);
    expect((await as('/api/decide', 'POST', { approved: true })).status).toBe(403);
    expect((await as('/api/pause', 'POST', {})).status).toBe(403);
    expect(existsSync(env.PAUSE_FILE)).toBe(false);
  });

  it('lets an operator preview but not approve', async () => {
    const operator = await login(base, 'oscar', PASSWORDS.operator);
    const headers = { cookie: operator, 'content-type': 'application/json' };
    const intent = { kind: 'native_transfer', to: '0x2222222222222222222222222222222222222222', amount: '0.0005' };
    const preview = await fetch(`${base}/api/preview`, { method: 'POST', headers, body: JSON.stringify({ intent }) });
    expect(preview.status).toBe(200);
    const decide = await fetch(`${base}/api/decide`, { method: 'POST', headers, body: JSON.stringify({ approved: true }) });
    expect(decide.status).toBe(403);
  });

  it('rejects a wrong password, throttles repeated failures and logs each attempt', async () => {
    const attempt = () =>
      fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'oscar', password: 'not-the-password' }),
      });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
    expect(appends).toContainEqual({ type: 'access', data: { event: 'login', user: 'oscar', ok: false } });
  });

  it('logout ends the session', async () => {
    const viewer = await login(base, 'vera', PASSWORDS.viewer);
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: viewer, 'content-type': 'application/json' } });
    expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: viewer } })).status).toBe(401);
  });

  const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    authed(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('refuses a cross-site no-cors POST that would approve a waiting T2', async () => {
    // A web page can send text/plain without a preflight; the server must not parse it.
    const r = await authed(`${base}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ approved: true }),
    });
    expect(r.status).toBe(415);
  });

  it('refuses requests from a foreign Origin or a rebound Host', async () => {
    const foreign = await postJson('/api/decide', { approved: true }, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    // fetch cannot override Host, so send the rebinding case with node:http.
    const port = (server.address() as AddressInfo).port;
    const rebound = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/api/pending', headers: { host: 'evil.example' } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      })
        .on('error', reject)
        .end();
    });
    expect(rebound).toBe(403);
    const local = await authed(`${base}/api/pending`, { headers: { origin: 'http://localhost:5173' } });
    expect(local.status).toBe(200);
  });

  it('reports status and a budget view built from the audit log', async () => {
    const status = await (await authed(`${base}/api/status`)).json();
    expect(status).toMatchObject({ chainId: 84532, paused: false, vault: null, llm: false });
    const budget = await (await authed(`${base}/api/budget`)).json();
    expect(budget).toMatchObject({
      paused: false,
      txLastHour: 0,
      maxTxPerHour: 5,
      assets: [{ asset: 'ETH', spentToday: '0', dailyBudget: '0.02', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01' }],
    });
  });

  it('pauses the wallet from the UI and logs it; there is no resume route', async () => {
    const r = await postJson('/api/pause', {});
    expect(await r.json()).toEqual({ paused: true });
    expect(existsSync(env.PAUSE_FILE)).toBe(true);
    expect(appends).toContainEqual({ type: 'kill_switch', data: { paused: true, by: 'web', user: 'olivia' } });
    expect((await (await authed(`${base}/api/status`)).json()).paused).toBe(true);
    expect((await postJson('/api/resume', {})).status).toBe(404);
    rmSync(env.PAUSE_FILE, { force: true });
  });

  it('reports no pending approval and rejects decide with nothing waiting', async () => {
    expect(await (await authed(`${base}/api/pending`)).json()).toEqual({ pending: null, expiresAt: null });
    const r = await authed(`${base}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    expect(await r.json()).toEqual({ decided: false });
  });

  it('rejects invalid bodies (bad intent, non-boolean approval, bad JSON)', async () => {
    const badPreview = await authed(`${base}/api/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: { kind: 'native_transfer', to: '0x123', amount: '1' } }),
    });
    expect(badPreview.status).toBe(400);
    const badDecide = await authed(`${base}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: 'yes please' }),
    });
    expect(badDecide.status).toBe(400);
    const badJson = await authed(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    expect(badJson.status).toBe(400);
  });

  it('parks a T2 transact until the UI rejects, and nothing is sent', async () => {
    const tx = authed(`${base}/api/transact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intent: { kind: 'native_transfer', to: '0x2222222222222222222222222222222222222222', amount: '0.0005' },
      }),
    }).then((r) => r.json());
    let pending: { pending: string | null } = { pending: null };
    for (let i = 0; i < 50 && !pending.pending; i++) {
      await new Promise((r) => setTimeout(r, 20));
      pending = (await (await authed(`${base}/api/pending`)).json()) as typeof pending;
    }
    expect(pending.pending).toContain('T2_CONFIRM');
    expect((pending as { expiresAt?: number }).expiresAt).toBeGreaterThan(Date.now());
    const decided = await (
      await authed(`${base}/api/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: false }),
      })
    ).json();
    expect(decided).toEqual({ decided: true });
    expect(appends).toContainEqual({ type: 'access', data: { event: 'decide', user: 'olivia', approved: false } });
    await expect(tx).resolves.toMatchObject({ status: 'rejected_by_human' });
    expect(await (await authed(`${base}/api/pending`)).json()).toEqual({ pending: null, expiresAt: null });
  });

  it('refuses chat without an LLM key instead of calling the network', async () => {
    const r = await authed(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: expect.stringMatching(/LLM_API_KEY/) });
  });

  it('serves a helpful error when the UI is not built, and 404s unknown routes', async () => {
    const root = await authed(`${base}/`);
    expect(root.status).toBe(404);
    const missing = await authed(`${base}/api/nope`);
    expect(missing.status).toBe(404);
  });
});

describe('hardening headers, policy hash and CSV export', () => {
  let server: Server;
  let base = '';
  let cookie = '';
  // Own users file: the first suite deletes its temp dir when it finishes.
  const dir2 = mkdtempSync(join(tmpdir(), 'aw-users-'));
  const users2 = new UserStore(join(dir2, 'users.json'));
  const ownerPassword = users2.add('olivia', 'owner');

  beforeAll(async () => {
    const { ctx, approver } = stubCtx({});
    server = createServer({ env, ctx, approver, users: users2, distDir: '/nonexistent-dist' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cookie = await login(base, 'olivia', ownerPassword);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir2, { recursive: true, force: true });
  });

  it('sets hardening headers on every API response, including errors', async () => {
    for (const path of ['/api/status', '/api/nope']) {
      const r = await fetch(`${base}${path}`, { headers: { cookie } });
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
    }
  });

  it('never allows inline scripts unless their hash is in the CSP', async () => {
    const html = '<script>var t=1</script><script src="/src/main.tsx"></script>';
    const hashes = inlineScriptHashes(html);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);
    expect(inlineScriptHashes('<script src="/x.js"></script>')).toEqual([]);
    const r = await fetch(`${base}/api/status`, { headers: { cookie } });
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).not.toContain("'unsafe-inline' 'self'");
    expect(csp).toMatch(/script-src 'self'/);
  });

  it('exposes the policy file hash in /api/status', async () => {
    const status = (await (await fetch(`${base}/api/status`, { headers: { cookie } })).json()) as { policyHash?: string };
    expect(status.policyHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('exports the audit log as CSV for signed-in readers only', async () => {
    expect((await fetch(`${base}/api/audit/export`)).status).toBe(401);
    const r = await fetch(`${base}/api/audit/export`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toContain('agentvault-audit.csv');
    expect((await r.text()).split('\n')[0]).toBe('seq,ts,type,data');
  });
});
