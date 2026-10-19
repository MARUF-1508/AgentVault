import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/agent/tools.js';
import { WebApprover } from '../src/approval/approver.js';
import { EmailApprover, signLink, verifyLink, type Mail } from '../src/approval/email.js';
import { UserStore } from '../src/auth/users.js';
import type { Env } from '../src/config.js';
import { createServer } from '../src/web/server.js';
import { harness } from './helpers.js';

const SECRET = 's'.repeat(40);
const ID = '11111111-2222-4333-8444-555555555555';

/** Pulls the query parameters of the approve or reject link out of a mail body. */
function linkFrom(mail: Mail, action: 'approve' | 'reject'): Record<string, string> {
  const line = mail.text.split('\n').find((l) => l.toLowerCase().startsWith(`${action}:`))!;
  return Object.fromEntries(new URL(line.slice(line.indexOf('http'))).searchParams);
}

describe('email approval links (I4)', () => {
  it('signs a link bound to one request, one action and its deadline', () => {
    const exp = Date.now() + 60_000;
    const q = Object.fromEntries(new URLSearchParams(signLink(SECRET, { id: ID, action: 'approve', exp })));
    expect(verifyLink(SECRET, q)).toEqual({ ok: true, link: { id: ID, action: 'approve', exp } });
    // Flip the action, change the deadline, or use another secret: refused.
    expect(verifyLink(SECRET, { ...q, action: 'reject' })).toEqual({ ok: false, reason: 'bad signature' });
    expect(verifyLink(SECRET, { ...q, exp: String(exp + 1) })).toEqual({ ok: false, reason: 'bad signature' });
    expect(verifyLink('x'.repeat(40), q)).toEqual({ ok: false, reason: 'bad signature' });
    expect(verifyLink(SECRET, q, exp + 1)).toEqual({ ok: false, reason: 'link expired' });
    expect(verifyLink(SECRET, { ...q, id: '../../etc' })).toEqual({ ok: false, reason: 'malformed link' });
    expect(verifyLink(SECRET, {})).toEqual({ ok: false, reason: 'malformed link' });
  });

  it('mails the summary with both links, and a mail failure never blocks the web path', async () => {
    const { audit } = harness();
    const web = new WebApprover(60_000);
    const sent: Mail[] = [];
    web.addNotifier(
      new EmailApprover({ send: async (m) => void sent.push(m), from: 'vault@example.com', to: 'owner@example.com', baseUrl: 'http://127.0.0.1:5174/', secret: SECRET, audit }),
    );
    const answer = web.confirm('  Action : native_transfer\n  Tier   : T2_CONFIRM');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const mail = sent[0]!;
    expect(mail).toMatchObject({ to: 'owner@example.com', subject: 'Agent Vault: approval needed' });
    expect(mail.text).toContain('Tier   : T2_CONFIRM');
    expect(mail.text).toContain('http://127.0.0.1:5174/api/approve-link?');
    const approve = linkFrom(mail, 'approve');
    expect(verifyLink(SECRET, approve)).toMatchObject({ ok: true, link: { id: web.getPendingDetail()!.id, action: 'approve' } });
    expect(audit.read().some((e) => e.data.event === 'approval_emailed')).toBe(true);

    // The link decides once; the same link again changes nothing.
    expect(EmailApprover.decideFromLink(web, audit, SECRET, approve)).toMatchObject({ ok: true });
    await expect(answer).resolves.toBe(true);
    expect(web.lastDecidedBy).toBe('email');
    expect(EmailApprover.decideFromLink(web, audit, SECRET, approve)).toMatchObject({ ok: false });

    const broken = new WebApprover(60_000);
    broken.addNotifier(
      new EmailApprover({ send: async () => Promise.reject(new Error('SMTP down')), from: 'a@b.co', to: 'c@d.co', baseUrl: 'http://x', secret: SECRET, audit }),
    );
    const pending = broken.confirm('x');
    await vi.waitFor(() => expect(audit.read().some((e) => e.data.event === 'approval_email_failed')).toBe(true));
    expect(broken.decide(false, broken.getPendingDetail()!.id)).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it('a link for an older request cannot decide a newer one', async () => {
    const { audit } = harness();
    const web = new WebApprover(60_000);
    const stale = Object.fromEntries(new URLSearchParams(signLink(SECRET, { id: ID, action: 'approve', exp: Date.now() + 60_000 })));
    const answer = web.confirm('newer request');
    expect(EmailApprover.decideFromLink(web, audit, SECRET, stale)).toMatchObject({ ok: false });
    expect(web.getPending()).toBe('newer request');
    web.decide(false, web.getPendingDetail()!.id);
    await answer;
  });
});

describe('email approval routes', () => {
  let server: Server;
  let base = '';
  const dir = mkdtempSync(join(tmpdir(), 'av-email-'));
  const h = harness();
  const web = new WebApprover(60_000);
  const sent: Mail[] = [];
  web.addNotifier(new EmailApprover({ send: async (m) => void sent.push(m), from: 'a@b.co', to: 'c@d.co', baseUrl: 'http://127.0.0.1', secret: SECRET, audit: h.audit }));

  beforeAll(async () => {
    const policyFile = join(dir, 'policy.json');
    writeFileSync(policyFile, JSON.stringify(h.policy));
    const env = { POLICY_FILE: policyFile, PAUSE_FILE: join(dir, 'PAUSED') } as Env;
    const ctx: ToolContext = { clients: h.clients, policy: h.policy, executor: h.executor, audit: h.audit };
    server = createServer({ env, ctx, approver: web, users: new UserStore(join(dir, 'users.json')), distDir: '/nonexistent', emailLinks: { secret: SECRET } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  const postForm = (body: Record<string, string>, origin?: string) =>
    fetch(`${base}/api/approve-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
      body: new URLSearchParams(body).toString(),
    });

  it('opening a link only shows a confirmation page; the same-origin button decides', async () => {
    sent.length = 0;
    const answer = web.confirm('  Action : native_transfer\n  Target : to <script>alert(1)</script>');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const approve = linkFrom(sent[0]!, 'approve');

    // A mail scanner prefetching the link must not approve anything.
    const page = await fetch(`${base}/api/approve-link?${new URLSearchParams(approve)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Approve this transaction?');
    expect(html).toContain('&lt;script&gt;'); // summary is escaped
    expect(html).not.toContain('<script>alert');
    expect(web.getPending()).not.toBeNull();

    // A form post with no Origin, or from another site, is refused.
    expect((await postForm(approve)).status).toBe(403);
    expect((await postForm(approve, 'https://evil.example')).status).toBe(403);
    expect(web.getPending()).not.toBeNull();

    const done = await postForm(approve, base);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Approved.');
    await expect(answer).resolves.toBe(true);
    // Used once: the page now says it is gone.
    expect((await fetch(`${base}/api/approve-link?${new URLSearchParams(approve)}`)).status).toBe(410);
  });

  it('a tampered link is refused and other routes still reject form posts', async () => {
    const r = await fetch(`${base}/api/approve-link?id=${ID}&action=approve&exp=1&sig=nope`);
    expect(r.status).toBe(410);
    const other = await fetch(`${base}/api/pause`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: 'x=1',
    });
    expect(other.status).toBe(415);
  });
});
