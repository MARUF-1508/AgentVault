import { describe, expect, it, vi } from 'vitest';
import { fetchPaidData, PaymentRequiredSchema } from '../src/x402.js';
import { runTool, type ToolContext } from '../src/agent/tools.js';
import { PolicySchema } from '../src/policy/types.js';

const PAY_TO = '0x4785Dca37A242F3D80f844CB0b143A687008a2B5';
const ORIGIN = 'http://127.0.0.1:8790';
const URL_ = `${ORIGIN}/premium-quote`;

const required = {
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:84532',
      asset: 'ETH',
      payTo: PAY_TO,
      maxAmountRequired: '200000000000000',
      resource: '/premium-quote',
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('x402 payment-required schema', () => {
  it('accepts a well-formed 402 body', () => {
    expect(PaymentRequiredSchema.safeParse(required).success).toBe(true);
  });

  it('rejects a bad payee, a non-numeric price and an empty accepts list', () => {
    const bad = (over: object) => ({ ...required, accepts: [{ ...required.accepts[0], ...over }] });
    expect(PaymentRequiredSchema.safeParse(bad({ payTo: 'not-an-address' })).success).toBe(false);
    expect(PaymentRequiredSchema.safeParse(bad({ maxAmountRequired: '0.0002' })).success).toBe(false);
    expect(PaymentRequiredSchema.safeParse({ x402Version: 1, accepts: [] }).success).toBe(false);
  });
});

describe('fetchPaidData', () => {
  const deps = (fetchFn: typeof fetch, execute: Parameters<typeof fetchPaidData>[2]['execute']) => ({
    fetchFn,
    execute,
    network: 'Base Sepolia',
    symbol: 'ETH',
  });

  it('pays through the executor and retries once with the tx hash as proof', async () => {
    const calls: Array<{ url: string; payment?: string }> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), payment: headers.get('x-payment') ?? undefined });
      return headers.get('x-payment') ? jsonResponse(200, { report: 'premium data' }) : jsonResponse(402, required);
    }) as typeof fetch;

    const execute = vi.fn(async (intent: { kind: string; to: string; amount: string }) => {
      expect(intent).toEqual({ kind: 'native_transfer', to: PAY_TO, amount: '0.0002' });
      return { status: 'executed', txHash: '0xtx', decision: { tier: 'T1_AUTO', reasons: [] } };
    });

    const result = await fetchPaidData(URL_, ORIGIN, deps(fetchFn, execute));
    expect(result.error).toBeUndefined();
    expect(result.paid).toBe('0.0002 ETH');
    expect(result.txHash).toBe('0xtx');
    expect(result.data).toEqual({ report: 'premium data' });
    expect(calls).toEqual([{ url: URL_ }, { url: URL_, payment: '0xtx' }]);
  });

  it('never pays when the policy denies, and does not retry', async () => {
    let requests = 0;
    const fetchFn = (async () => {
      requests++;
      return jsonResponse(402, required);
    }) as typeof fetch;
    const execute = vi.fn(async () => ({
      status: 'denied',
      decision: { tier: 'T3_DENY', reasons: ['above the hard cap'] },
    }));

    const result = await fetchPaidData(URL_, ORIGIN, deps(fetchFn, execute));
    expect(result.tier).toBe('T3_DENY');
    expect(result.error).toMatch(/denied/i);
    expect(requests).toBe(1);
  });

  it('refuses any origin but the configured one before making a request', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const result = await fetchPaidData('https://evil.example/premium-quote', ORIGIN, deps(fetchFn, vi.fn()));
    expect(result.error).toMatch(/only http:\/\/127\.0\.0\.1:8790 is allowed/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('passes a 200 through untouched and reports other HTTP errors', async () => {
    const free = (async () => jsonResponse(200, { free: true })) as typeof fetch;
    expect((await fetchPaidData(URL_, ORIGIN, deps(free, vi.fn()))).data).toEqual({ free: true });

    const broken = (async () => jsonResponse(500, { error: 'boom' })) as typeof fetch;
    expect((await fetchPaidData(URL_, ORIGIN, deps(broken, vi.fn()))).error).toMatch(/HTTP 500/);
  });

  it('reports a paid-but-rejected retry without pretending it succeeded', async () => {
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Headers(init?.headers).get('x-payment') ? jsonResponse(403, { error: 'nope' }) : jsonResponse(402, required)) as typeof fetch;
    const execute = vi.fn(async () => ({ status: 'executed', txHash: '0xdead', decision: { tier: 'T2_CONFIRM', reasons: [] } }));

    const result = await fetchPaidData(URL_, ORIGIN, deps(fetchFn, execute));
    expect(result.txHash).toBe('0xdead');
    expect(result.error).toMatch(/HTTP 403/);
  });
});

describe('fetch_paid_data tool wiring', () => {
  const policy = PolicySchema.parse({
    version: 1,
    chainId: 84532,
    native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
    tokens: {},
    recipients: { allowlist: {}, denylist: [] },
    approvals: { allowUnlimited: false, spenderAllowlist: {} },
    rateLimit: { maxTxPerHour: 5 },
  });

  const ctx = (x402ApiUrl?: string) =>
    ({
      clients: { publicClient: {}, chain: { id: 84532, name: 'Base Sepolia' } },
      policy,
      executor: {},
      audit: {},
      x402ApiUrl,
    }) as unknown as ToolContext;

  it('explains the missing configuration instead of calling anything', async () => {
    expect(await runTool('fetch_paid_data', JSON.stringify({ url: URL_ }), ctx(undefined))).toEqual({
      error: 'The paid API is not configured (set X402_API_URL).',
    });
  });

  it('rejects a non-URL argument without touching the network', async () => {
    const result = (await runTool('fetch_paid_data', JSON.stringify({ url: 'not a url' }), ctx(ORIGIN))) as { error?: string };
    expect(result.error).toMatch(/absolute URL/);
  });
});
