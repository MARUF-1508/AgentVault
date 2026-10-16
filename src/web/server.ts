import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { normalize, sep } from 'node:path';
import type OpenAI from 'openai';
import { z } from 'zod';
import { chatTurn } from '../agent/agent.js';
import { runTool, type ToolContext } from '../agent/tools.js';
import type { WebApprover } from '../approval/approver.js';
import type { Env } from '../config.js';
import { IntentSchema } from '../policy/types.js';

export interface WebServerOptions {
  env: Env;
  ctx: ToolContext;
  approver: WebApprover;
  /** Directory with the built UI (`web/dist`). Missing dir => JSON hint. */
  distDir?: string;
}

const DecideSchema = z.object({ approved: z.boolean() });
const ChatSchema = z.object({ message: z.string().min(1).max(4000), session: z.string().max(100).optional() });
const TransactSchema = z.object({ intent: z.unknown() });

const stringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(stringify(body));
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
  const sessions = new Map<string, OpenAI.Chat.Completions.ChatCompletionMessageParam[]>();

  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

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
        return send(res, 200, { pending: approver.getPending() });
      }
      if (req.method === 'POST' && path === '/api/decide') {
        const parsed = DecideSchema.safeParse(await readBody(req));
        if (!parsed.success) return send(res, 400, { error: 'Body must be { approved: boolean }.' });
        return send(res, 200, { decided: approver.decide(parsed.data.approved) });
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
        const history = sessions.get(session) ?? [];
        const answer = await chatTurn(env, ctx, history, parsed.data.message);
        sessions.set(session, history);
        return send(res, 200, { session, answer });
      }

      if (req.method === 'GET') {
        const file = serveStatic(distDir, path);
        if (file) {
          res.writeHead(200, { 'content-type': file.type });
          return res.end(file.body);
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
