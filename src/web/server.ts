import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, normalize, sep } from 'node:path';
import type OpenAI from 'openai';
import { formatUnits } from 'viem';
import { z } from 'zod';
import { chatTurn } from '../agent/agent.js';
import { runTool, type ToolContext } from '../agent/tools.js';
import type { WebApprover } from '../approval/approver.js';
import { can, permissionsOf, ROLES, type Permission } from '../auth/rbac.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../auth/totp.js';
import { LoginThrottle, Sessions, type User, type UserStore } from '../auth/users.js';
import type { Env } from '../config.js';
import { pauseWallet } from '../policy/killswitch.js';
import { addDenied, addRecipient, applyPolicy, removeDenied, removeRecipient, writePolicyAtomic } from '../policy/edit.js';
import { spendStateFrom } from '../policy/state.js';
import { ActionIntentSchema, IntentSchema } from '../policy/types.js';
import { dailyStats } from '../report/stats.js';

export interface WebServerOptions {
  env: Env;
  ctx: ToolContext;
  approver: WebApprover;
  /** Directory with the built UI (`web/dist`). Missing dir => JSON hint. */
  distDir?: string;
  /** Set in VAULT=true mode, so the UI can show that on-chain caps apply. */
  vault?: { address: `0x${string}`; tokens?: boolean };
  /** Web-UI accounts. Every /api route except login needs a session. */
  users: UserStore;
  sessions?: Sessions;
}

/** Which permission each API route needs. Anything not listed is 404. */
export const ROUTES: Record<string, Permission> = {
  'GET /api/status': 'read',
  'GET /api/budget': 'read',
  'GET /api/info': 'read',
  'GET /api/portfolio': 'read',
  'GET /api/policy': 'read',
  'GET /api/activity': 'read',
  'GET /api/stats': 'read',
  'GET /api/audit/export': 'read',
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
  // Recipient lists. Owner-only ('admin'), never a tool, so the LLM cannot reach
  // them. The two directions that lower a recipient's tier also need the owner's
  // password again.
  'POST /api/policy/recipients/add': 'admin',
  'POST /api/policy/recipients/remove': 'admin',
  'POST /api/policy/deny/add': 'admin',
  'POST /api/policy/deny/remove': 'admin',
};

/** First 16 hex chars of the policy file's sha256, shown in the UI. */
function policyHashOf(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * sha256 hashes of inline <script> blocks, for the CSP. The built index.html
 * carries one inline theme script, so allowing hashes keeps script-src at 'self'.
 */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(re)) {
    if (m[1]?.trim()) out.push(`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  }
  return out;
}

const COOKIE = 'av_session';
const LoginSchema = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(1).max(200),
  code: z.string().max(10).optional(),
});
const SetupSchema = z.object({ username: z.string().regex(/^[a-z0-9_-]{2,32}$/), password: z.string().min(10).max(200) });
const AddUserSchema = z.object({ username: z.string().regex(/^[a-z0-9_-]{2,32}$/), role: z.enum(ROLES) });
const RemoveUserSchema = z.object({ username: z.string().regex(/^[a-z0-9_-]{2,32}$/) });
const AddRecipientSchema = z.object({ label: z.string(), address: z.string(), password: z.string().max(200).optional() });
const RemoveRecipientSchema = z.object({ label: z.string() });
const DenySchema = z.object({ address: z.string() });
const UndenySchema = z.object({ address: z.string(), password: z.string().max(200).optional() });

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
 * First line of defence, ahead of sign-in: a Host header that is not loopback
 * means DNS rebinding; an Origin that is not loopback means another website is
 * calling us. POSTs must be JSON, which forces a CORS preflight that this server
 * never answers, so a cross-site form or no-cors fetch cannot approve a T2 or
 * trigger a transaction. Every /api route beyond login and first-run setup then
 * still requires a signed-in session (see ROUTES).
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
  '.webmanifest': 'application/manifest+json',
};

/**
 * Web UI server. It binds loopback only (published as 127.0.0.1:8787 in Docker),
 * so it must never be exposed beyond the owner's machine. Sign-in is required
 * for every /api route except login and first-run setup, and role-based access
 * is enforced server-side. All state changes still go through the executor
 * (approvals via the shared WebApprover), so the policy firewall applies exactly
 * as in the CLI.
 */
export function createServer(opts: WebServerOptions): Server {
  const { env, ctx, approver } = opts;
  const distDir = opts.distDir ?? 'web/dist';
  const vault = opts.vault;
  const { users } = opts;
  const sessions = opts.sessions ?? new Sessions();
  const throttle = new LoginThrottle();
  const chats = new Map<string, OpenAI.Chat.Completions.ChatCompletionMessageParam[]>();
  // Unconfirmed TOTP secrets: enabled only after one valid code (10-minute window).
  const pendingTotp = new Map<string, { secret: string; at: number }>();
  // Recomputed per request, never cached: the owner can edit the recipient lists
  // at runtime, and a fingerprint that lags behind would make the UI lie about
  // which policy is loaded.
  const policyHash = () => policyHashOf(env.POLICY_FILE);

  // Strict CSP; the one inline script (pre-paint theme pick) is hash-allowed.
  let scriptSrc = "'self'";
  try {
    const hashes = inlineScriptHashes(readFileSync(join(distDir, 'index.html'), 'utf8'));
    if (hashes.length) scriptSrc += ` ${hashes.join(' ')}`;
  } catch {
    // UI not built yet; 'self' alone is fine.
  }
  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  return createHttpServer(async (req, res) => {
    try {
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('content-security-policy', csp);
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
        if (!user) {
          throttle.fail(username);
          ctx.audit.append('access', { event: 'login', user: username, ok: false });
          return send(res, 401, { error: 'Wrong username or password.' });
        }
        // Second factor, when the account has it: no session is created until
        // both factors pass; the code prompt is driven by the `totp` flag.
        const secret = users.totpSecret(username);
        if (secret) {
          const code = parsed.data.code ?? '';
          if (!code) {
            ctx.audit.append('access', { event: 'login', user: username, ok: false, reason: 'totp_required' });
            return send(res, 401, { error: 'Enter the 6-digit code from your authenticator app.', totp: true });
          }
          if (!verifyTotp(secret, code)) {
            throttle.fail(username);
            ctx.audit.append('access', { event: 'login', user: username, ok: false, reason: 'totp_wrong' });
            return send(res, 401, { error: 'Wrong authenticator code.', totp: true });
          }
        }
        throttle.clear(username);
        ctx.audit.append('access', { event: 'login', user: username, ok: true });
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
        return send(res, 200, {
          user: user.username,
          role: user.role,
          permissions: permissionsOf(user.role),
          totpEnabled: users.totpSecret(user.username) !== null,
        });
      }
      // Self-service 2FA: setup returns a secret (pending until one code
      // confirms it), enable confirms it, disable re-checks the password. All
      // three act on the signed-in user only, so no extra role is required.
      if (req.method === 'GET' && path === '/api/auth/totp') {
        if (!user) return send(res, 401, { error: 'Not signed in.' });
        return send(res, 200, { enabled: users.totpSecret(user.username) !== null });
      }
      if (req.method === 'POST' && path === '/api/auth/totp/setup') {
        if (!user) return send(res, 401, { error: 'Not signed in.' });
        const secret = generateTotpSecret();
        pendingTotp.set(user.username, { secret, at: Date.now() });
        ctx.audit.append('access', { event: 'totp_setup_started', user: user.username });
        return send(res, 200, { secret, uri: otpauthUri(user.username, secret) });
      }
      if (req.method === 'POST' && path === '/api/auth/totp/enable') {
        if (!user) return send(res, 401, { error: 'Not signed in.' });
        const parsed = z.object({ code: z.string().max(10) }).safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: 'Body must be { code }.' });
        const pending = pendingTotp.get(user.username);
        if (!pending || Date.now() - pending.at > 10 * 60_000) {
          return send(res, 400, { error: 'Start the two-factor setup again.' });
        }
        if (!verifyTotp(pending.secret, parsed.data.code)) {
          return send(res, 400, { error: 'That code is not right. Check the device clock and try again.' });
        }
        users.setTotp(user.username, pending.secret);
        pendingTotp.delete(user.username);
        // Changing the second factor changes what counts as this account, so end
        // every other session: anyone holding a token minted before 2FA was on is
        // now signed out. The session performing the change is kept.
        const revoked = sessions.destroyUserExcept(user.username, cookieToken(req));
        ctx.audit.append('access', { event: 'totp_enabled', user: user.username, revoked });
        return send(res, 200, { enabled: true });
      }
      if (req.method === 'POST' && path === '/api/auth/totp/disable') {
        if (!user) return send(res, 401, { error: 'Not signed in.' });
        const parsed = z.object({ password: z.string().min(1).max(200) }).safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: 'Body must be { password }.' });
        if (!users.verify(user.username, parsed.data.password)) {
          throttle.fail(user.username);
          return send(res, 401, { error: 'Wrong password.' });
        }
        users.setTotp(user.username, null);
        // Turning the second factor off is itself a security-relevant change:
        // end every other session, keeping only the one doing it.
        const revoked = sessions.destroyUserExcept(user.username, cookieToken(req));
        ctx.audit.append('access', { event: 'totp_disabled', user: user.username, revoked });
        return send(res, 200, { enabled: false });
      }
      if (req.method === 'POST' && path === '/api/auth/sessions/revoke') {
        if (!user) return send(res, 401, { error: 'Not signed in.' });
        const revoked = sessions.destroyUserExcept(user.username, cookieToken(req));
        ctx.audit.append('access', { event: 'sessions_revoked', user: user.username, revoked });
        return send(res, 200, { revoked });
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
          policyHash: policyHash(),
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

      // Owner-only recipient-list edits. Hand-editing config/policy.json used to be
      // the only way to change these, which left every change unaudited and unchecked;
      // these routes make it an owner-only, re-authenticated, logged operation.
      if (path.startsWith('/api/policy/recipients/') || path.startsWith('/api/policy/deny/')) {
        // Adding a known recipient, or un-denying one, lowers the tier that address
        // gets, so those two need the owner's password again.
        const escalating = path === '/api/policy/recipients/add' || path === '/api/policy/deny/remove';
        const schema =
          path === '/api/policy/recipients/add'
            ? AddRecipientSchema
            : path === '/api/policy/recipients/remove'
              ? RemoveRecipientSchema
              : path === '/api/policy/deny/add'
                ? DenySchema
                : UndenySchema;
        const parsed = schema.safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: 'Check the recipient fields and try again.' });
        if (escalating) {
          const password = (parsed.data as { password?: unknown }).password;
          if (typeof password !== 'string' || !password) {
            return send(res, 403, { error: 'This change lowers the tier for that address. Confirm your password to continue.' });
          }
          if (!users.verify(user!.username, password)) {
            throttle.fail(user!.username);
            return send(res, 401, { error: 'Wrong password.' });
          }
        }
        const before = policyHash();
        let next;
        try {
          if (path === '/api/policy/recipients/add') {
            const { label, address } = parsed.data as z.infer<typeof AddRecipientSchema>;
            next = addRecipient(ctx.policy, label, address);
          } else if (path === '/api/policy/recipients/remove') {
            const { label } = parsed.data as z.infer<typeof RemoveRecipientSchema>;
            next = removeRecipient(ctx.policy, label);
          } else if (path === '/api/policy/deny/add') {
            const { address } = parsed.data as z.infer<typeof DenySchema>;
            next = addDenied(ctx.policy, address);
          } else {
            const { address } = parsed.data as z.infer<typeof UndenySchema>;
            next = removeDenied(ctx.policy, address);
          }
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        // Write first, then swap the live object: if the file system refuses (the
        // Docker image mounts config/ read-only) nothing changes at all.
        try {
          writePolicyAtomic(env.POLICY_FILE, next);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          return send(res, code === 'EROFS' ? 409 : 500, {
            error:
              code === 'EROFS'
                ? 'The policy file is read-only in this deployment. Edit config/policy.json or use npm run cli -- recipient.'
                : 'Could not write the policy file.',
          });
        }
        applyPolicy(ctx.policy, next);
        const event = path.endsWith('/add')
          ? path.includes('deny')
            ? 'deny_added'
            : 'recipient_added'
          : path.includes('deny')
            ? 'deny_removed'
            : 'recipient_removed';
        ctx.audit.append('access', { event, by: user!.username, escalated: escalating, policyHashBefore: before, policyHashAfter: policyHash() });
        return send(res, 200, { policyHash: policyHash(), allowlist: ctx.policy.recipients.allowlist, denylist: ctx.policy.recipients.denylist });
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
      if (req.method === 'GET' && path === '/api/stats') {
        return send(res, 200, dailyStats(ctx.audit.read()));
      }
      if (req.method === 'GET' && path === '/api/audit/export') {
        const csvEscape = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
        const rows = ctx.audit.read().map((e) => [e.seq, e.ts, e.type, csvEscape(stringify(e.data))].join(','));
        const csv = ['seq,ts,type,data', ...rows].join('\n') + '\n';
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="agentvault-audit.csv"',
        });
        return res.end(csv);
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
        // /api/transact is the generic path for transfers and approvals only. A swap
        // must go through the execute_swap orchestration, which prices it and sends a
        // bounded approval first; accepting one here would bypass that. /api/preview
        // stays read-only, so it may still preview any intent.
        const schema = path === '/api/transact' ? ActionIntentSchema : IntentSchema;
        const intent = schema.safeParse(parsed.data.intent);
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
