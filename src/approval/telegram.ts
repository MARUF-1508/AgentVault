import type { AuditLog } from '../audit/log.js';
import type { ApprovalNotifier, PendingApproval, WebApprover } from './approver.js';

type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

interface Update {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number; username?: string };
    message?: { message_id: number; chat?: { id: number } };
  };
}

/**
 * Out-of-band approver (I4): every T2 request is also posted to one Telegram
 * chat with Approve / Reject buttons, so an owner can answer from their phone.
 *
 * It decides nothing itself. A button press is passed to `WebApprover.decide`
 * with the request id, so the same rules apply as in the web UI: the id must
 * match the request still waiting, an expired request cannot be revived, and
 * the executor re-checks the policy before signing. Only callbacks coming from
 * the configured chat are honoured; anything else is ignored and logged.
 *
 * Opt-in: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. The token is a secret and
 * is redacted from the audit log like the other configured secrets.
 */
export class TelegramApprover implements ApprovalNotifier {
  private offset = 0;
  private running = false;
  private readonly messages = new Map<string, number>();
  private readonly api: string;
  private readonly fetchFn: FetchFn;

  constructor(
    token: string,
    private readonly chatId: string,
    private readonly approver: WebApprover,
    private readonly audit: AuditLog,
    fetchFn?: FetchFn,
  ) {
    this.api = `https://api.telegram.org/bot${token}`;
    this.fetchFn = fetchFn ?? (fetch as unknown as FetchFn);
  }

  private async call(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const res = await this.fetchFn(`${this.api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const json = (await res.json()) as { ok?: boolean; result?: unknown };
    if (!res.ok || !json.ok) throw new Error(`Telegram ${method} failed`);
    return json.result;
  }

  async notify(p: PendingApproval): Promise<void> {
    const minutes = Math.max(1, Math.round((p.expiresAt - Date.now()) / 60_000));
    const text = `Agent Vault: approval needed (expires in ~${minutes} min)\n\n${p.summary.slice(0, 3500)}`;
    try {
      const result = (await this.call('sendMessage', {
        chat_id: this.chatId,
        text,
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Approve', callback_data: `a:${p.id}` },
              { text: 'Reject', callback_data: `r:${p.id}` },
            ],
          ],
        },
      })) as { message_id?: number };
      if (result?.message_id) this.messages.set(p.id, result.message_id);
    } catch {
      // A Telegram outage never blocks the web approval path.
    }
  }

  async settled(id: string, approved: boolean, by: string): Promise<void> {
    const messageId = this.messages.get(id);
    this.messages.delete(id);
    if (!messageId) return;
    const verdict = by === 'timeout' ? 'Expired: rejected automatically.' : `${approved ? 'Approved' : 'Rejected'} (${by}).`;
    try {
      await this.call('editMessageReplyMarkup', { chat_id: this.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
      await this.call('sendMessage', { chat_id: this.chatId, text: verdict, reply_to_message_id: messageId });
    } catch {
      // best-effort
    }
  }

  /** Handles one batch of updates. Exposed for tests; `start` loops it. */
  async pollOnce(signal?: AbortSignal, timeoutSec = 25): Promise<number> {
    const updates = (await this.call(
      'getUpdates',
      { offset: this.offset, timeout: timeoutSec, allowed_updates: ['callback_query'] },
      signal,
    )) as Update[];
    for (const u of updates ?? []) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const q = u.callback_query;
      if (!q?.data) continue;
      const fromChat = String(q.message?.chat?.id ?? '');
      const match = /^([ar]):([0-9a-f-]{36})$/.exec(q.data);
      if (fromChat !== this.chatId || !match) {
        this.audit.append('access', { event: 'decide', channel: 'telegram', ok: false, reason: 'foreign chat or malformed button' });
        continue;
      }
      const approved = match[1] === 'a';
      const decided = this.approver.decide(approved, match[2], 'telegram');
      this.audit.append('access', {
        event: 'decide',
        channel: 'telegram',
        user: q.from?.username ?? String(q.from?.id ?? 'unknown'),
        approved,
        ok: decided,
      });
      try {
        await this.call('answerCallbackQuery', {
          callback_query_id: q.id,
          text: decided ? (approved ? 'Approved' : 'Rejected') : 'This request is no longer waiting.',
        });
      } catch {
        // best-effort
      }
    }
    return updates?.length ?? 0;
  }

  /** Long-polls Telegram until `stop`. Errors back off and retry; they never crash the server. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      while (this.running) {
        try {
          await this.pollOnce();
        } catch {
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    };
    void loop();
  }

  stop(): void {
    this.running = false;
  }
}
