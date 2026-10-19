import { describe, expect, it, vi } from 'vitest';
import { WebApprover } from '../src/approval/approver.js';
import { TelegramApprover } from '../src/approval/telegram.js';
import { Scheduler } from '../src/schedule/background.js';
import type { ScheduleDeps } from '../src/schedule/runner.js';
import { RateLimiter } from '../src/web/ratelimit.js';
import { harness } from './helpers.js';

/** A fake Telegram Bot API: records calls and returns queued updates. */
function fakeTelegram(updates: unknown[][]) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchFn = async (url: string, init?: { body?: string }) => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    const body = JSON.parse(init?.body ?? '{}');
    calls.push({ method, body });
    const result = method === 'getUpdates' ? (updates.shift() ?? []) : method === 'sendMessage' ? { message_id: 7 } : true;
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
  return { calls, fetchFn };
}

describe('Telegram approver (I4)', () => {
  it('posts the request with buttons and approves only with the matching id from the configured chat', async () => {
    const { audit } = harness();
    const web = new WebApprover(60_000);
    const tg = fakeTelegram([]);
    const bot = new TelegramApprover('123:token', '42', web, audit, tg.fetchFn);
    web.addNotifier(bot);

    const answer = web.confirm('Action : native_transfer\n  Tier   : T2_CONFIRM');
    await vi.waitFor(() => expect(tg.calls.some((c) => c.method === 'sendMessage')).toBe(true));
    const id = web.getPendingDetail()!.id;
    const sent = tg.calls.find((c) => c.method === 'sendMessage')!.body;
    expect(sent.chat_id).toBe('42');
    expect(JSON.stringify(sent.reply_markup)).toContain(`a:${id}`);

    // A press from a different chat, and a stale id, are both ignored.
    tg.calls.length = 0;
    const foreign = fakeTelegram([
      [
        { update_id: 1, callback_query: { id: 'q1', data: `a:${id}`, message: { message_id: 7, chat: { id: 999 } } } },
        { update_id: 2, callback_query: { id: 'q2', data: 'a:00000000-0000-4000-8000-000000000000', message: { message_id: 7, chat: { id: 42 } } } },
      ],
      [{ update_id: 3, callback_query: { id: 'q3', data: `a:${id}`, from: { id: 5, username: 'olivia' }, message: { message_id: 7, chat: { id: 42 } } } }],
    ]);
    const bot2 = new TelegramApprover('123:token', '42', web, audit, foreign.fetchFn);
    await bot2.pollOnce(undefined, 0);
    expect(web.getPending()).not.toBeNull();
    await bot2.pollOnce(undefined, 0);
    await expect(answer).resolves.toBe(true);
    expect(web.lastDecidedBy).toBe('telegram');
    const decides = audit.read().filter((e) => e.type === 'access' && e.data.channel === 'telegram');
    expect(decides.map((e) => e.data.ok)).toEqual([false, false, true]);
  });

  it('a Telegram outage never breaks the web approval path', async () => {
    const { audit } = harness();
    const web = new WebApprover(60_000);
    web.addNotifier(
      new TelegramApprover('t', '1', web, audit, async () => {
        throw new Error('network down');
      }),
    );
    const answer = web.confirm('x');
    const id = web.getPendingDetail()!.id;
    expect(web.decide(false, id)).toBe(true);
    await expect(answer).resolves.toBe(false);
  });
});

describe('background scheduler (T5)', () => {
  it('runs due rules on each tick, never overlaps ticks, and survives a failing tick', async () => {
    let calls = 0;
    let release!: () => void;
    const run = vi.fn(async () => {
      calls++;
      if (calls === 1) await new Promise<void>((r) => (release = r));
      if (calls === 2) throw new Error('rpc down');
      return [{ ruleId: 'r', status: 'executed' }];
    });
    const s = new Scheduler(() => ({}) as ScheduleDeps, 60, run as never);
    const first = s.tick();
    expect(await s.tick()).toBeNull(); // still in flight
    release();
    await first;
    expect(await s.tick()).toEqual([]);
    expect(s.status.lastError).toBe('rpc down');
    expect(await s.tick()).toEqual([{ ruleId: 'r', status: 'executed' }]);
    expect(s.status.lastError).toBeNull();
    s.start();
    expect(s.status.enabled).toBe(true);
    s.stop();
    expect(s.status.enabled).toBe(false);
  });
});

describe('API rate limiter', () => {
  it('allows max hits per window per user and bucket, then asks to wait', () => {
    let now = 0;
    const rl = new RateLimiter({ chat: { max: 2, windowMs: 10_000 } }, () => now);
    expect(rl.take('a', 'chat')).toBe(0);
    expect(rl.take('a', 'chat')).toBe(0);
    expect(rl.take('a', 'chat')).toBe(10);
    expect(rl.take('b', 'chat')).toBe(0); // another user is unaffected
    expect(rl.take('a', 'other')).toBe(0); // unknown bucket is unlimited
    now = 10_001;
    expect(rl.take('a', 'chat')).toBe(0);
  });
});
