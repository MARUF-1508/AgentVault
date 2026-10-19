import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuditLog } from '../audit/log.js';
import type { ApprovalNotifier, PendingApproval, WebApprover } from './approver.js';

/**
 * Email approver (I4, second channel next to Telegram). Each T2 request is
 * mailed to the owner with two signed links, one to approve and one to reject.
 *
 * A link is a capability bound to one request: HMAC-SHA256 over
 * `id | action | expiresAt` with a server secret, so it cannot be forged,
 * cannot be reused for a different request, and dies with the request (same
 * deadline as the web approval). Opening a link changes nothing: it shows a
 * confirmation page, and only the button on that page (a same-origin POST)
 * decides. That matters because mail scanners prefetch links; a GET that
 * approved would let a scanner approve a payment.
 *
 * Every decision goes through `WebApprover.decide(approved, id)`, so the id
 * check, the timeout and the executor's re-check before signing all still apply,
 * and a T3 can never be approved because it never reaches the approver.
 */
export type ApprovalAction = 'approve' | 'reject';

export interface LinkParams {
  id: string;
  action: ApprovalAction;
  exp: number;
}

export interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export type SendMail = (mail: Mail) => Promise<unknown>;

function sign(secret: string, p: LinkParams): string {
  return createHmac('sha256', secret).update(`${p.id}|${p.action}|${p.exp}`).digest('base64url');
}

/** The query string for one signed link. */
export function signLink(secret: string, p: LinkParams): string {
  const q = new URLSearchParams({ id: p.id, action: p.action, exp: String(p.exp), sig: sign(secret, p) });
  return q.toString();
}

/** Validates untrusted link parameters. Returns the parsed link or why it is refused. */
export function verifyLink(
  secret: string,
  raw: { id?: unknown; action?: unknown; exp?: unknown; sig?: unknown },
  now = Date.now(),
): { ok: true; link: LinkParams } | { ok: false; reason: string } {
  const { id, action, exp, sig } = raw;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return { ok: false, reason: 'malformed link' };
  if (action !== 'approve' && action !== 'reject') return { ok: false, reason: 'malformed link' };
  const expNum = Number(exp);
  if (typeof exp !== 'string' || !/^\d{1,16}$/.test(exp) || !Number.isSafeInteger(expNum)) return { ok: false, reason: 'malformed link' };
  if (typeof sig !== 'string' || sig.length > 100) return { ok: false, reason: 'malformed link' };
  const link: LinkParams = { id, action, exp: expNum };
  const want = Buffer.from(sign(secret, link));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'bad signature' };
  if (now > expNum) return { ok: false, reason: 'link expired' };
  return { ok: true, link };
}

/** A per-process secret when none is configured: links then die with a restart (fail closed). */
export function linkSecret(configured?: string): string {
  return configured && configured.length >= 32 ? configured : randomBytes(32).toString('base64url');
}

export class EmailApprover implements ApprovalNotifier {
  constructor(
    private readonly opts: {
      send: SendMail;
      from: string;
      to: string;
      /** Where the owner's browser reaches the UI, e.g. http://127.0.0.1:5174. */
      baseUrl: string;
      secret: string;
      audit: AuditLog;
    },
  ) {}

  async notify(p: PendingApproval): Promise<void> {
    const link = (action: ApprovalAction) =>
      `${this.opts.baseUrl.replace(/\/$/, '')}/api/approve-link?${signLink(this.opts.secret, { id: p.id, action, exp: p.expiresAt })}`;
    const minutes = Math.max(1, Math.round((p.expiresAt - Date.now()) / 60_000));
    const text = [
      'Agent Vault: a transaction is waiting for your approval.',
      '',
      p.summary,
      '',
      `Approve: ${link('approve')}`,
      `Reject:  ${link('reject')}`,
      '',
      `The links work for about ${minutes} minute(s), only for this request, and only from a browser that can reach the Agent Vault UI.`,
      'Opening a link shows a confirmation page first; nothing is decided until you press its button.',
      'If you did not expect this, reject it or pause the wallet.',
    ].join('\n');
    try {
      await this.opts.send({ from: this.opts.from, to: this.opts.to, subject: 'Agent Vault: approval needed', text });
      this.opts.audit.append('access', { event: 'approval_emailed', channel: 'email' });
    } catch (err) {
      // A mail outage never blocks the web approval path; it is only recorded.
      this.opts.audit.append('access', { event: 'approval_email_failed', channel: 'email', error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Handles the confirmation button. Returns what the page should say.
   * `decide` only succeeds while this exact request is still waiting.
   */
  static decideFromLink(
    approver: WebApprover,
    audit: AuditLog,
    secret: string,
    raw: Record<string, unknown>,
    now = Date.now(),
  ): { ok: boolean; message: string } {
    const v = verifyLink(secret, raw, now);
    if (!v.ok) {
      audit.append('access', { event: 'decide', channel: 'email', ok: false, reason: v.reason });
      return { ok: false, message: `This link cannot be used (${v.reason}). Nothing was signed.` };
    }
    const approved = v.link.action === 'approve';
    const decided = approver.decide(approved, v.link.id, 'email');
    audit.append('access', { event: 'decide', channel: 'email', user: 'email link', approved, ok: decided });
    if (!decided) return { ok: false, message: 'This request is no longer waiting (answered elsewhere or expired). Nothing changed.' };
    return { ok: true, message: approved ? 'Approved. The policy is checked once more, then the transaction is signed.' : 'Rejected. Nothing was signed.' };
  }
}

/** SMTP transport from SMTP_URL; nodemailer is loaded only when email approvals are configured. */
export async function smtpSender(url: string): Promise<SendMail> {
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport(url);
  return (mail) => transport.sendMail(mail);
}
