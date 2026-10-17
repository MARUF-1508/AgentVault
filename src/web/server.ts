import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { normalize, sep } from 'node:path';
import type OpenAI from 'openai';
import { formatUnits } from 'viem';
import { z } from 'zod';
import { chatTurn } from '../agent/agent.js';
import { runTool, type ToolContext } from '../agent/tools.js';
import type { WebApprover } from '../approval/approver.js';
import { can, permissionsOf, ROLES, type Permission } from '../auth/rbac.js';
import { LoginThrottle, Sessions, type User, type UserStore } from '../auth/users.js';
import type { Env } from '../config.js';
import { pauseWallet } from '../policy/killswitch.js';
import { spendStateFrom } from '../policy/state.js';
import { IntentSchema } from '../policy/types.js';

export interface WebServerOptions {
  env: Env;
  ctx: ToolContext;
  approver: WebApprover;
  /** Directory with the built UI (`web/dist`). Missing dir => JSON hint. */
  distDir?: string;
  /** Set in VAULT=true mode, so the UI can show that on-chain caps apply. */
  vault?: { address: `0x${string}` };
  /** Web-UI accounts. Every /api route except login needs a session. */
  users: UserStore;
  sessions?: Sessions;
}

/** Which permission each API route needs. Anything not listed is 404. */
const ROUTES: Record<string, Permission> = {
  'GET /api/status': 'read',
  'GET /api/budget': 'read',
  'GET /api/info': 'read',
  'GET /api/portfolio': 'read',
  'GET /api/policy': 'read',
  'GET /api/activity': 'read',
  'GET /api/verify': 'read',
  'GET /api/pending': 'read',
  'GET /api/users': 'admin',
  'POST /api/users': 'admin',
  'POST /api/users/remove': 'admin',
  'POST /api/preview': 'preview',
  'POST /api/transact': 'transact',
  'POST /api/chat': 'chat',
  'POST /api/decide': 'approve',
  'POST /api/pause': 'pause',
};

const COOKIE = 'av_session';
const LoginSchema = z.object({ username: z.string().min(1).max(32), password: z.string().min(1).max(200) });
const SetupSchema = z.object({ username: z.string().regex(/^[a-z0-9_-]{2,32}$/), password: z.string().min(10).max(200) });
const AddUserSchema = z.object({ username: z.string().regex(/^[a-z0-9_-]{2,32}$/), role: z.enum(ROLES) });
const RemoveUserSchema = z.object({ username: z.string().regex(/^[a-z0-9_-]{2,32}$/) });

function cookieToken(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return undefined;
}

function setCookie(res: ServerResponse, token: string, maxAgeSec: number): void {
  // HttpOnly: page scripts cannot read it. SameSite=Strict: other sites never send it.
  res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`);
}

const DecideSchema = z.object({ approved: z.boolean() });
const ChatSchema = z.object({ message: z.string().min(1).max(4000), session: z.string().max(100).optional() });
const TransactSchema = z.object({ intent: z.unknown() });

const stringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(stringify(body));
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostnameOf(value: string | undefined, withScheme: boolean): string | null {
  if (!value) return null;
  try {
    return new URL(withScheme ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Browser-facing guard for a server with no auth. A Host header that is not
 * loopback means DNS rebinding; an Origin that is not loopback means another
 * website is calling us. POSTs must be JSON, which forces a CORS preflight that
 * this server never answers, so a cross-site form or no-cors fetch cannot
 * approve a T2 or trigger a transaction.
 */
function rejectForeign(req: IncomingMessage): { status: number; error: string } | null {
  const host = hostnameOf(req.headers.host, false);
  if (!host || !LOOPBACK.has(host)) return { status: 403, error: 'Host must be loopback.' };
  const origin = req.headers.origin;
  if (origin !== undefined && !LOOPBACK.has(hostnameOf(origin, true) ?? '')) {
    return { status: 403, error: 'Cross-origin requests are refused.' };
  }
  if (req.method === 'POST' && !(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    return { status: 415, error: 'POST bodies must be application/json.' };
  }
  return null;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * Local demo server for the web UI. Binds loopback only and has no auth, so it
 * must never be exposed beyond the owner's machine. All state changes still go
 * through the executor (approvals via the shared WebApprover), so the policy
 * firewall applies exactly as in the CLI.
 */
export function createServer(opts: WebServerOptions): Server {
  const { env, ctx, approver } = opts;
  const distDir = opts.distDir ?? 'web/dist';
  const vault = opts.vault;
  const { users } = opts;
  const sessions = opts.sessions ?? new Sessions();
  const throttle = new LoginThrottle();
  const chats = new Map<string, OpenAI.Chat.Completions.ChatCompletionMessageParam[]>();

  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const foreign = rejectForeign(req);
      if (foreign) return send(res, foreign.status, { error: foreign.error });

      if (req.method === 'POST' && path === '/api/auth/login') {
        const parsed = LoginSchema.safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: 'Body must be { username, password }.' });
        const { username, password } = parsed.data;
        if (throttle.blocked(username)) {
          ctx.audit.append('access', { event: 'login', user: username, ok: false, reason: 'throttled' });
          return send(res, 429, { error: 'Too many failed sign-ins. Try again in 15 minutes.' });
        }
        const user = users.verify(username, password);
        ctx.audit.append('access', { event: 'login', user: username, ok: Boolean(user) });
        if (!user) {
          throttle.fail(username);
          return send(res, 401, { error: 'Wrong username or password.' });
        }
        throttle.clear(username);
        const { token, maxAgeSec } = sessions.create(user);
        setCookie(res, token, maxAgeSec);
        return send(res, 200, { user: user.username, role: user.role, permissions: permissionsOf(user.role) });
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        sessions.destroy(cookieToken(req));
        setCookie(res, '', 0);
        return send(res, 200, { ok: true });
      }
      // First-run setup: the only moment an account can be created without an
      // owner. Later accounts are owner-managed (/api/users) or CLI-only.
      if (req.method === 'GET' && path === '/api/auth/setup') {
        return send(res, 200, { needed: users.list().length === 0 });
      }
      if (req.method === 'POST' && path === '/api/auth/setup') {
        if (users.list().length > 0) return send(res, 409, { error: 'Already set up. Ask an owner to add you.' });
        const parsed = SetupSchema.safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: 'Username: 2-32 of a-z 0-9 _ -. Password: at least 10 characters.' });
        users.add(parsed.data.username, 'owner', parsed.data.password);
        const { token, maxAgeSec } = sessions.create({ username: parsed.data.username, role: 'owner' });
        setCookie(res, token, maxAgeSec);
        ctx.audit.append('access', { event: 'setup', user: parsed.data.username, ok: true });
        return send(res, 201, { user: parsed.data.username, role: 'owner', permissions: permissionsOf('owner') });
      }

      const user: User | null = sessions.get(cookieToken(req));
      if (req.method === 'GET' && path === '/api/auth/me') {
        if (!user) return send(res, 401, { error: 'Not signed in.' });
        return send(res, 200, { user: user.username, role: user.role, permissions: permissionsOf(user.role) });
      }
      const needs = ROUTES[`${req.method} ${path}`];
      if (path.startsWith('/api/') && needs) {
        if (!user) return send(res, 401, { error: 'Not signed in.' });
        if (!can(user.role, needs)) return send(res, 403, { error: `Your role (${user.role}) cannot ${needs}.` });
      }

      if (req.method === 'GET' && path === '/api/status') {
        const { chain, account } = ctx.clients;
        return send(res, 200, {
          address: account?.address ?? null,
          chain: chain.name,
          chainId: chain.id,
          explorer: chain.blockExplorers?.default.url ?? null,
          paused: spendStateFrom([], env.PAUSE_FILE).paused,
          vault: vault?.address ?? null,
          llm: Boolean(env.LLM_API_KEY),
          model: env.LLM_API_KEY ? env.LLM_MODEL : null,
        });
      }
      if (req.method === 'GET' && path === '/api/budget') {
        return send(res, 200, budgetView(ctx, env.PAUSE_FILE));
      }
      if (req.method === 'POST' && path === '/api/pause') {
        pauseWallet(env.PAUSE_FILE, ctx.audit, 'web', user!.username);
        return send(res, 200, { paused: true });
      }
      // Owner-only account management. Passwords are generated server-side and
      // returned exactly once; neither the LLM nor the web can read them again.
      if (req.method === 'GET' && path === '/api/users') {
        return send(res, 200, { users: users.list(), you: user!.username });
      }
      if (req.method === 'POST' && path === '/api/users') {
        const parsed = AddUserSchema.safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: 'Username: 2-32 of a-z 0-9 _ -. Role: owner, operator or viewer.' });
        const { username, role } = parsed.data;
        const password = users.add(username, role);
        sessions.destroyUser(username);
        ctx.audit.append('access', { event: 'user_added', by: user!.username, user: username, role });
        return send(res, 201, { username, role, password });
      }
      if (req.method === 'POST' && path === '/api/users/remove') {
        const parsed = RemoveUserSchema.safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: 'Body must be { username }.' });
        const { username } = parsed.data;
        if (username === user!.username) return send(res, 400, { error: 'You cannot remove your own account.' });
        const target = users.list().find((u) => u.username === username);
        if (!target) return send(res, 404, { error: `No user ${username}.` });
        const owners = users.list().filter((u) => u.role === 'owner');
        if (target.role === 'owner' && owners.length === 1) {
          return send(res, 400, { error: 'This is the last owner. Add another owner first.' });
        }
        users.remove(username);
        sessions.destroyUser(username);
        ctx.audit.append('access', { event: 'user_removed', by: user!.username, user: username });
        return send(res, 200, { removed: true });
      }

      if (req.method === 'GET' && path === '/api/info') {
        return send(res, 200, await runTool('get_wallet_info', '{}', ctx));
      }
      if (req.method === 'GET' && path === '/api/portfolio') {
        return send(res, 200, await runTool('get_portfolio', '{}', ctx));
      }
      if (req.method === 'GET' && path === '/api/policy') {
        return send(res, 200, await runTool('get_policy', '{}', ctx));
      }
      if (req.method === 'GET' && path === '/api/activity') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20), 1), 50);
        return send(res, 200, await runTool('get_recent_activity', JSON.stringify({ limit }), ctx));
      }
      if (req.method === 'GET' && path === '/api/verify') {
        return send(res, 200, ctx.audit.verify());
      }
      if (req.method === 'GET' && path === '/api/pending') {
        const detail = approver.getPendingDetail();
        return send(res, 200, { pending: detail?.summary ?? null, expiresAt: detail?.expiresAt ?? null });
      }
      if (req.method === 'POST' && path === '/api/decide') {
        const parsed = DecideSchema.safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: 'Body must be { approved: boolean }.' });
        const decided = approver.decide(parsed.data.approved);
        if (decided) ctx.audit.append('access', { event: 'decide', user: user!.username, approved: parsed.data.approved });
        return send(res, 200, { decided });
      }
      if (req.method === 'POST' && (path === '/api/preview' || path === '/api/transact')) {
        const parsed = TransactSchema.safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: 'Body must be { intent }.' });
        const intent = IntentSchema.safeParse(parsed.data.intent);
        if (!intent.success) {
          return send(res, 400, { error: 'Invalid intent', issues: intent.error.issues.map((i) => i.message) });
        }
        if (path === '/api/preview') {
          const d = await ctx.executor.preview(intent.data);
          return send(res, 200, { tier: d.tier, reasons: d.reasons });
        }
        const r = await ctx.executor.execute(intent.data);
        return send(res, 200, {
          status: r.status,
          tier: r.decision.tier,
          reasons: r.decision.reasons,
          txHash: r.txHash,
          explorerUrl: r.explorerUrl,
          error: r.error,
        });
      }
      if (req.method === 'POST' && path === '/api/chat') {
        const parsed = ChatSchema.safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: 'Body must be { message, session? }.' });
        if (!env.LLM_API_KEY) return send(res, 400, { error: 'LLM_API_KEY is not set; chat needs a model endpoint.' });
        const session = parsed.data.session ?? randomUUID();
        // Histories are per user, so one account can never read another's chat.
        const key = `${user!.username}:${session}`;
        const history = chats.get(key) ?? [];
        const events: string[] = [];
        const answer = await chatTurn(env, ctx, history, parsed.data.message, (e) => events.push(e));
        chats.set(key, history);
        return send(res, 200, { session, answer, events });
      }

      if (req.method === 'GET') {
        const file = serveStatic(distDir, path);
        if (file) {
          res.writeHead(200, { 'content-type': file.type });
          return res.end(file.body);
        }
        // Client-side routes (/activity, /security, ...) all load the SPA shell.
        const shell = !path.startsWith('/api/') && !path.includes('.') ? serveStatic(distDir, '/') : null;
        if (shell) {
          res.writeHead(200, { 'content-type': shell.type });
          return res.end(shell.body);
        }
        if (path === '/' || !path.startsWith('/api/')) {
          return send(res, 404, { error: 'Web UI is not built. Run `npm run build` inside web/ and restart serve.' });
        }
      }
      return send(res, 404, { error: `Unknown route ${req.method} ${path}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'request body too large' || message === 'request body is not valid JSON') {
        return send(res, 400, { error: message });
      }
      return send(res, 500, { error: message });
    }
  });
}

/** Today's spend per asset against its limits, rebuilt from the audit log. */
function budgetView(ctx: ToolContext, pauseFile: string) {
  const { policy } = ctx;
  const state = spendStateFrom(ctx.audit.read(), pauseFile);
  const assets = [
    { asset: policy.native.symbol, decimals: 18, limits: policy.native },
    ...Object.entries(policy.tokens).map(([asset, t]) => ({ asset, decimals: t.decimals, limits: t })),
  ];
  return {
    paused: state.paused,
    txLastHour: state.txLastHour,
    maxTxPerHour: policy.rateLimit.maxTxPerHour,
    assets: assets.map(({ asset, decimals, limits }) => ({
      asset,
      spentToday: formatUnits(state.spentToday[asset] ?? 0n, decimals),
      dailyBudget: limits.dailyBudget,
      autoMaxPerTx: limits.autoMaxPerTx,
      hardMaxPerTx: limits.hardMaxPerTx,
    })),
  };
}

function serveStatic(distDir: string, path: string): { type: string; body: Buffer } | null {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const full = normalize(distDir + sep + rel);
  if (!full.startsWith(normalize(distDir) + sep) || !existsSync(full)) return null;
  try {
    const body = readFileSync(full);
    const dot = full.lastIndexOf('.');
    const type = STATIC_TYPES[full.slice(dot).toLowerCase()] ?? 'application/octet-stream';
    return { type, body };
  } catch {
    return null;
  }
}
