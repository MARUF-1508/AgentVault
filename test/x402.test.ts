import { describe, expect, it, vi } from 'vitest';
import { decodePayment, encodePayment, fetchPaidData, PaymentRequiredSchema } from '../src/x402.js';
import { runTool, type ToolContext } from '../src/agent/tools.js';
import { PolicySchema } from '../src/policy/types.js';

const PAY_TO = '0x4785Dca37A242F3D80f844CB0b143A687008a2B5';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ORIGIN = 'http://127.0.0.1:8790';
const URL_ = `${ORIGIN}/premium-quote`;
const TX = `0x${'ab'.repeat(32)}`;
const TX2 = `0x${'cd'.repeat(32)}`;

/** A v1 offer (maxAmountRequired) as an older server would send it. */
const v1 = {
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

/** A v2 offer (amount) as the current spec sends it. */
const v2 = {
  x402Version: 2,
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:84532',
      asset: 'ETH',
      payTo: PAY_TO,
      amount: '200000000000000',
      resource: '/premium-quote',
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('x402 payment-required schema', () => {
  it('accepts a well-formed v1 body', () => {
    expect(PaymentRequiredSchema.safeParse(v1).success).toBe(true);
  });

  it('accepts a v2 body with CAIP-2 and the renamed amount field', () => {
    expect(PaymentRequiredSchema.safeParse(v2).success).toBe(true);
  });

  it('rejects a bad payee, a non-numeric price, an empty accepts list and a missing amount', () => {
    const bad = (over: object) => ({ ...v1, accepts: [{ ...v1.accepts[0], ...over }] });
    expect(PaymentRequiredSchema.safeParse(bad({ payTo: 'not-an-address' })).success).toBe(false);
    expect(PaymentRequiredSchema.safeParse(bad({ maxAmountRequired: '0.0002' })).success).toBe(false);
    expect(PaymentRequiredSchema.safeParse({ x402Version: 2, accepts: [] }).success).toBe(false);
    expect(
      PaymentRequiredSchema.safeParse({ ...v2, accepts: [{ ...v2.accepts[0], amount: undefined }] }).success,
    ).toBe(false);
  });
});

describe('decodePayment', () => {
  it('round-trips a v2 base64 payload and also accepts a bare tx hash', () => {
    const header = encodePayment({ x402Version: 2, scheme: 'exact', network: 'eip155:84532', payload: { txHash: TX } });
    expect(decodePayment(header)?.payload.txHash).toBe(TX);
    expect(decodePayment(TX)?.payload).toEqual({ txHash: TX });
    expect(decodePayment('not a payment')).toBeNull();
  });
});

describe('fetchPaidData', () => {
  const deps = (fetchFn: typeof fetch, execute: Parameters<typeof fetchPaidData>[2]['execute']) => ({
    fetchFn,
    execute,
    network: 'Base Sepolia',
    caip2: 'eip155:84532',
    symbol: 'ETH',
  });

  it('pays through the executor and retries once with a v2 payment payload', async () => {
    const calls: Array<{ url: string; payment?: string }> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const payment = new Headers(init?.headers).get('x-payment') ?? undefined;
      calls.push({ url: String(input), payment });
      return payment ? jsonResponse(200, { report: 'premium data' }) : jsonResponse(402, v2);
    }) as typeof fetch;

    const execute = vi.fn(async (intent: { kind: string; to: string; amount: string }) => {
      expect(intent).toEqual({ kind: 'native_transfer', to: PAY_TO, amount: '0.0002' });
      return { status: 'executed', txHash: TX, decision: { tier: 'T1_AUTO', reasons: [] } };
    });

    const result = await fetchPaidData(URL_, ORIGIN, deps(fetchFn, execute));
    expect(result.error).toBeUndefined();
    expect(result.paid).toBe('0.0002 ETH');
    expect(result.txHash).toBe(TX);
    expect(result.data).toEqual({ report: 'premium data' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.payment).toBeUndefined();
    expect(decodePayment(calls[1]!.payment!)).toMatchObject({ x402Version: 2, network: 'eip155:84532', payload: { txHash: TX } });
  });

  it('selects the offer on our chain by CAIP-2 when several are offered', async () => {
    const multi = {
      x402Version: 2,
      accepts: [
        { scheme: 'exact', network: 'eip155:1', asset: 'ETH', payTo: PAY_TO, amount: '999', resource: '/premium-quote' },
        { scheme: 'exact', network: 'eip155:84532', asset: 'ETH', payTo: PAY_TO, amount: '200000000000000', resource: '/premium-quote' },
      ],
    };
    const fetchFn = (async (_i: RequestInfo | URL, init?: RequestInit) =>
      new Headers(init?.headers).get('x-payment') ? jsonResponse(200, { ok: true }) : jsonResponse(402, multi)) as typeof fetch;
    const execute = vi.fn(async (intent: { amount: string }) => {
      expect(intent.amount).toBe('0.0002');
      return { status: 'executed', txHash: TX, decision: { tier: 'T1_AUTO', reasons: [] } };
    });
    expect((await fetchPaidData(URL_, ORIGIN, deps(fetchFn, execute))).paid).toBe('0.0002 ETH');
  });

  it('treats a settlement_pending 402 as non-terminal and never retries again', async () => {
    let requests = 0;
    const fetchFn = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      return new Headers(init?.headers).get('x-payment')
        ? jsonResponse(402, { status: 'settlement_pending', txHash: TX2 })
        : jsonResponse(402, v2);
    }) as typeof fetch;
    const execute = vi.fn(async () => ({ status: 'executed', txHash: TX2, decision: { tier: 'T1_AUTO', reasons: [] } }));

    const result = await fetchPaidData(URL_, ORIGIN, deps(fetchFn, execute));
    expect(result.status).toBe('settlement_pending');
    expect(result.txHash).toBe(TX2);
    expect(requests).toBe(2); // the 402, then the proof — no further payment attempt
  });

  it('refuses an ERC-20 offer instead of mis-paying it as native ETH', async () => {
    const erc20 = {
      x402Version: 2,
      accepts: [{ scheme: 'exact', network: 'eip155:84532', asset: USDC, payTo: PAY_TO, amount: '200000', resource: '/premium-quote' }],
    };
    const fetchFn = (async () => jsonResponse(402, erc20)) as typeof fetch;
    const execute = vi.fn();
    const result = await fetchPaidData(URL_, ORIGIN, deps(fetchFn, execute));
    expect(result.error).toMatch(/ERC-20/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('never pays when the policy denies, and does not retry', async () => {
    let requests = 0;
    const fetchFn = (async () => {
      requests++;
      return jsonResponse(402, v2);
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
    const fetchFn = (async (_i: RequestInfo | URL, init?: RequestInit) =>
      new Headers(init?.headers).get('x-payment') ? jsonResponse(403, { error: 'nope' }) : jsonResponse(402, v2)) as typeof fetch;
    const execute = vi.fn(async () => ({ status: 'executed', txHash: TX2, decision: { tier: 'T2_CONFIRM', reasons: [] } }));

    const result = await fetchPaidData(URL_, ORIGIN, deps(fetchFn, execute));
    expect(result.txHash).toBe(TX2);
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
