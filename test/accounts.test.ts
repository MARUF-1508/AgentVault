import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebApprover } from '../src/approval/approver.js';
import type { ToolContext } from '../src/agent/tools.js';
import type { AuditLog } from '../src/audit/log.js';
import { UserStore } from '../src/auth/users.js';
import type { Env } from '../src/config.js';
import { PolicySchema } from '../src/policy/types.js';
import { createServer } from '../src/web/server.js';

const policy = PolicySchema.parse({
  version: 1,
  chainId: 84532,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: {},
  recipients: { allowlist: {}, denylist: [] },
  approvals: { allowUnlimited: false, spenderAllowlist: {} },
  rateLimit: { maxTxPerHour: 5 },
});

const dir = mkdtempSync(join(tmpdir(), 'aw-accounts-'));
const env = {
  CHAIN: 'base-sepolia',
  LLM_BASE_URL: 'https://api.openai.com/v1',
  LLM_MODEL: 'gpt-4o-mini',
  POLICY_FILE: 'config/policy.json',
  AUDIT_LOG: 'data/audit.jsonl',
  PAUSE_FILE: join(dir, 'PAUSED'),
  ALLOW_MAINNET: 'false',
} as Env;

const appends: { type: string; data: Record<string, unknown> }[] = [];

describe('first-run setup and owner-managed accounts', () => {
  const users = new UserStore(join(dir, 'users.json'));
  let server: Server;
  let base = '';

  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  async function login(username: string, password: string): Promise<string> {
    const r = await post('/api/auth/login', { username, password });
    expect(r.status).toBe(200);
    return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  }

  beforeAll(async () => {
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
    const ctx = { clients, policy, executor: {}, audit } as unknown as ToolContext;
    server = createServer({ env, ctx, approver: new WebApprover(), users, distDir: '/nonexistent-dist' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('offers setup only while there are no accounts, then closes it forever', async () => {
    expect(await (await fetch(`${base}/api/auth/setup`)).json()).toEqual({ needed: true });
    const short = await post('/api/auth/setup', { username: 'root', password: 'short' });
    expect(short.status).toBe(400);
    const bad = await post('/api/auth/setup', { username: 'Root!', password: 'long-enough-password' });
    expect(bad.status).toBe(400);

    const created = await post('/api/auth/setup', { username: 'root', password: 'correct horse battery' });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ user: 'root', role: 'owner', permissions: expect.arrayContaining(['admin']) });
    const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await fetch(`${base}/api/users`, { headers: { cookie } })).status).toBe(200);
    expect(appends).toContainEqual({ type: 'access', data: { event: 'setup', user: 'root', ok: true } });

    expect(await (await fetch(`${base}/api/auth/setup`)).json()).toEqual({ needed: false });
    expect((await post('/api/auth/setup', { username: 'second', password: 'another long password' })).status).toBe(409);
  });

  it('adds accounts with a one-time password and audits it', async () => {
    const root = await login('root', 'correct horse battery');
    const added = await post('/api/users', { username: 'vera', role: 'viewer' }, root);
    expect(added.status).toBe(201);
    const body = (await added.json()) as { username: string; role: string; password: string };
    expect(body.username).toBe('vera');
    expect(body.password.length).toBeGreaterThanOrEqual(10);
    expect(appends).toContainEqual({ type: 'access', data: { event: 'user_added', by: 'root', user: 'vera', role: 'viewer' } });

    // The generated password works, and the listing never exposes hashes or passwords.
    const vera = await login('vera', body.password);
    const list = await (await fetch(`${base}/api/users`, { headers: { cookie: root } })).json();
    expect(list).toEqual({ users: expect.arrayContaining([{ username: 'vera', role: 'viewer' }]), you: 'root' });
    expect(JSON.stringify(list)).not.toContain(body.password);
    expect(JSON.stringify(list)).not.toContain('hash');

    // A viewer cannot manage accounts at all.
    expect((await fetch(`${base}/api/users`, { headers: { cookie: vera } })).status).toBe(403);
    expect((await post('/api/users', { username: 'x1', role: 'owner' }, vera)).status).toBe(403);
    expect((await post('/api/users/remove', { username: 'root' }, vera)).status).toBe(403);

    const bad = await post('/api/users', { username: 'x1', role: 'superuser' }, root);
    expect(bad.status).toBe(400);
  });

  it('removes accounts, kills their sessions, and refuses self-removal', async () => {
    const root = await login('root', 'correct horse battery');
    const vera = await login('vera', (await (await post('/api/users', { username: 'vera', role: 'viewer' }, root)).json() as { password: string }).password);
    expect((await fetch(`${base}/api/status`, { headers: { cookie: vera } })).status).toBe(200);

    const denied = await post('/api/users/remove', { username: 'root' }, root);
    expect(denied.status).toBe(400);
    expect((await denied.json()).error).toContain('your own account');

    expect((await post('/api/users/remove', { username: 'ghost' }, root)).status).toBe(404);

    expect((await post('/api/users/remove', { username: 'vera' }, root)).status).toBe(200);
    expect((await fetch(`${base}/api/status`, { headers: { cookie: vera } })).status).toBe(401);
    const gone = await post('/api/auth/login', { username: 'vera', password: 'whatever' });
    expect(gone.status).toBe(401);
    expect(appends).toContainEqual({ type: 'access', data: { event: 'user_removed', by: 'root', user: 'vera' } });
  });
});
