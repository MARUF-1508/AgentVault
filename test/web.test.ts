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
import { createServer } from '../src/web/server.js';
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

describe('web server', () => {
  let server: Server;
  let base = '';

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
    server = createServer({ env, ctx, approver, distDir: '/nonexistent-dist' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(env.PAUSE_FILE, { force: true });
  });

  const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('refuses a cross-site no-cors POST that would approve a waiting T2', async () => {
    // A web page can send text/plain without a preflight; the server must not parse it.
    const r = await fetch(`${base}/api/decide`, {
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
    const local = await fetch(`${base}/api/pending`, { headers: { origin: 'http://localhost:5173' } });
    expect(local.status).toBe(200);
  });

  it('reports status and a budget view built from the audit log', async () => {
    const status = await (await fetch(`${base}/api/status`)).json();
    expect(status).toMatchObject({ chainId: 84532, paused: false, vault: null, llm: false });
    const budget = await (await fetch(`${base}/api/budget`)).json();
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
    expect(appends).toContainEqual({ type: 'kill_switch', data: { paused: true, by: 'web' } });
    expect((await (await fetch(`${base}/api/status`)).json()).paused).toBe(true);
    expect((await postJson('/api/resume', {})).status).toBe(404);
    rmSync(env.PAUSE_FILE, { force: true });
  });

  it('reports no pending approval and rejects decide with nothing waiting', async () => {
    expect(await (await fetch(`${base}/api/pending`)).json()).toEqual({ pending: null, expiresAt: null });
    const r = await fetch(`${base}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    expect(await r.json()).toEqual({ decided: false });
  });

  it('rejects invalid bodies (bad intent, non-boolean approval, bad JSON)', async () => {
    const badPreview = await fetch(`${base}/api/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: { kind: 'native_transfer', to: '0x123', amount: '1' } }),
    });
    expect(badPreview.status).toBe(400);
    const badDecide = await fetch(`${base}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: 'yes please' }),
    });
    expect(badDecide.status).toBe(400);
    const badJson = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    expect(badJson.status).toBe(400);
  });

  it('parks a T2 transact until the UI rejects, and nothing is sent', async () => {
    const tx = fetch(`${base}/api/transact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intent: { kind: 'native_transfer', to: '0x2222222222222222222222222222222222222222', amount: '0.0005' },
      }),
    }).then((r) => r.json());
    let pending: { pending: string | null } = { pending: null };
    for (let i = 0; i < 50 && !pending.pending; i++) {
      await new Promise((r) => setTimeout(r, 20));
      pending = (await (await fetch(`${base}/api/pending`)).json()) as typeof pending;
    }
    expect(pending.pending).toContain('T2_CONFIRM');
    expect((pending as { expiresAt?: number }).expiresAt).toBeGreaterThan(Date.now());
    const decided = await (
      await fetch(`${base}/api/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: false }),
      })
    ).json();
    expect(decided).toEqual({ decided: true });
    await expect(tx).resolves.toMatchObject({ status: 'rejected_by_human' });
    expect(await (await fetch(`${base}/api/pending`)).json()).toEqual({ pending: null, expiresAt: null });
  });

  it('refuses chat without an LLM key instead of calling the network', async () => {
    const r = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: expect.stringMatching(/LLM_API_KEY/) });
  });

  it('serves a helpful error when the UI is not built, and 404s unknown routes', async () => {
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(404);
    const missing = await fetch(`${base}/api/nope`);
    expect(missing.status).toBe(404);
  });
});
