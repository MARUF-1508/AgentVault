import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { chatTurn, isChinese, isRetryable, SYSTEM_PROMPT, trimHistory } from '../src/agent/agent.js';
import { runTool, type ToolContext } from '../src/agent/tools.js';
import type { Env } from '../src/config.js';
import { ALICE, basePolicy, harness } from './helpers.js';

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
const env = { LLM_MODEL: 'test-model' } as Env;
const noSleep = async () => {};

function ctx(): ToolContext {
  const { executor, audit, clients, policy } = harness();
  return { clients, policy, executor, audit };
}

/** Each entry is either a reply or an error to throw for that call. */
function client(script: Array<{ content?: string; calls?: { name: string; args: unknown }[] } | Error>): OpenAI & { calls: number } {
  const c = {
    calls: 0,
    chat: {
      completions: {
        create: async () => {
          const step = script[Math.min(c.calls++, script.length - 1)]!;
          if (step instanceof Error) throw step;
          return {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: step.content ?? null,
                  tool_calls: step.calls?.map((x, j) => ({ id: `c${c.calls}_${j}`, type: 'function', function: { name: x.name, arguments: JSON.stringify(x.args) } })),
                },
              },
            ],
          };
        },
      },
    },
  };
  return c as unknown as OpenAI & { calls: number };
}

const status = (code: number) => Object.assign(new Error(`HTTP ${code}`), { status: code });

describe('agent loop', () => {
  it('retries a rate-limited or failing model call, then answers', async () => {
    const llm = client([status(429), status(503), { content: 'Done.' }]);
    const history: Message[] = [];
    expect(await chatTurn(env, ctx(), history, 'hi', undefined, llm, noSleep)).toBe('Done.');
    expect(llm.calls).toBe(3);
  });

  it('does not retry a bad request, and leaves the history as it was', async () => {
    const llm = client([status(400), { content: 'never' }]);
    const history: Message[] = [];
    await expect(chatTurn(env, ctx(), history, 'hi', undefined, llm, noSleep)).rejects.toThrow(/Nothing was sent/);
    expect(llm.calls).toBe(1);
    // Only the system prompt remains: no dangling user turn or tool call.
    expect(history.map((m) => m.role)).toEqual(['system']);
  });

  it('runs tools, wraps their output as untrusted, and explains the tier with the engine alternative', async () => {
    const llm = client([
      { calls: [{ name: 'preview_transaction', args: { kind: 'native_transfer', to: ALICE, amount: '1' } }] },
      { content: 'Refused; I can send 0.005 instead.' },
    ]);
    const history: Message[] = [];
    await chatTurn(env, ctx(), history, 'send 1 ETH to alice', undefined, llm, noSleep);
    const tool = history.find((m) => m.role === 'tool') as { content: string };
    expect(tool.content.startsWith('<untrusted>')).toBe(true);
    const payload = JSON.parse(tool.content.replace(/^<untrusted>|<\/untrusted>$/g, ''));
    expect(payload).toMatchObject({ tier: 'T3_DENY', explanation: expect.stringMatching(/Nobody can approve/), alternative: { available: true, intent: { amount: '0.005' } } });
  });

  it('stops after the step limit with a message in the user language', async () => {
    const loop = client([{ calls: [{ name: 'get_policy', args: {} }] }]);
    expect(await chatTurn(env, ctx(), [], 'hello', undefined, loop, noSleep)).toMatch(/Stopped after 8 tool steps/);
    expect(await chatTurn(env, ctx(), [], '给爱丽丝转账', undefined, client([{ calls: [{ name: 'get_policy', args: {} }] }]), noSleep)).toMatch(/已执行/);
  });

  it('trims long histories without separating a tool call from its result', () => {
    const history: Message[] = [{ role: 'system', content: 's' }];
    for (let i = 0; i < 30; i++) {
      history.push({ role: 'user', content: `u${i}` });
      history.push({ role: 'assistant', content: null, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'x', arguments: '{}' } }] });
      history.push({ role: 'tool', tool_call_id: `t${i}`, content: 'r' });
    }
    trimHistory(history, 10);
    expect(history[0]!.role).toBe('system');
    expect(history[1]!.role).toBe('user');
    expect(history.length - 1).toBeLessThanOrEqual(10);
    for (let i = 1; i < history.length; i++) {
      if (history[i]!.role === 'tool') expect(history[i - 1]!.role).toBe('assistant');
    }
  });

  it('detects Chinese and tells the model to reply in it', () => {
    expect(isChinese('给 alice 转 0.0001 ETH')).toBe(true);
    expect(isChinese('send 0.0001 ETH to alice')).toBe(false);
    expect(SYSTEM_PROMPT).toMatch(/简体中文/);
  });

  it('classifies retryable failures', () => {
    expect(isRetryable(status(429))).toBe(true);
    expect(isRetryable(status(500))).toBe(true);
    expect(isRetryable(status(401))).toBe(false);
    expect(isRetryable(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
  });
});

describe('new tools validate untrusted input', () => {
  it('get_transaction_status rejects a malformed hash and reports an unknown one', async () => {
    const c = ctx();
    expect(await runTool('get_transaction_status', JSON.stringify({ hash: 'nope' }), c)).toHaveProperty('error');
    expect(await runTool('get_transaction_status', JSON.stringify({ hash: `0x${'e'.repeat(64)}` }), c)).toMatchObject({ status: 'unknown' });
  });

  it('preview_batch refuses an unknown name and previews a valid batch', async () => {
    const c = ctx();
    expect(await runTool('preview_batch', JSON.stringify({ transfers: [{ to: 'mallory', amount: '1' }] }), c)).toHaveProperty('error');
    expect(await runTool('preview_batch', JSON.stringify({ transfers: [{ to: 'alice', amount: '0.0001' }] }), c)).toMatchObject({
      allowed: true,
      lines: [{ line: 1, tier: 'T1_AUTO' }],
    });
  });

  it('plan_rebalance rejects non-numeric targets before any chain read', async () => {
    const c = { ...ctx(), policy: basePolicy() };
    expect(await runTool('plan_rebalance', JSON.stringify({ targets: { USDC: 'half' } }), c)).toHaveProperty('error');
    expect(await runTool('plan_rebalance', JSON.stringify({ targets: [1, 2] }), c)).toHaveProperty('error');
  });

  it('execute_transaction attaches the engine alternative when it refuses', async () => {
    const r = await runTool('execute_transaction', JSON.stringify({ kind: 'native_transfer', to: ALICE, amount: '1' }), ctx());
    expect(r).toMatchObject({ status: 'denied', alternative: { available: true, intent: { amount: '0.005' } } });
  });
});
