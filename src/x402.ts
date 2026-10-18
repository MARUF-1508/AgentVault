import { formatEther, type Address } from 'viem';
import { z } from 'zod';

/**
 * x402 paid-API client. When a resource answers HTTP 402, the wallet pays the
 * advertised price and retries once with proof of payment. The payment goes
 * through Executor.execute like every other spending action, so the policy
 * engine (and possibly a human) decides whether it happens at all.
 *
 * Protocol notes (x402 v2):
 *  - `x402Version` is 1 or 2; v2 uses CAIP-2 network ids ("eip155:84532") and
 *    renamed `maxAmountRequired` to `amount`. Both shapes are accepted here.
 *  - The client presents proof in the `X-PAYMENT` header as a base64
 *    `PaymentPayload`. A server may also (as our demo does) accept a raw tx hash.
 *  - A resource may answer 402 with `settlement_pending` after the payment was
 *    broadcast but before it is finalised. That is **non-terminal**: the hash is
 *    preserved and returned, and we do **not** retry, because re-paying a
 *    broadcast payment is a double charge.
 *
 * This client settles by sending the transfer itself (native only). Full x402
 * uses a facilitator's /verify + /settle with a signed authorization; that is
 * deliberately out of scope for this testnet demo.
 */

/** CAIP-2 chain id, e.g. "eip155:84532". */
export const Caip2 = z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9-]+$/, 'CAIP-2 like "eip155:84532"');

/** One accepted payment. v2 renamed the amount field, so accept either. */
export const PaymentRequirementSchema = z
  .object({
    scheme: z.literal('exact'),
    network: z.string(),
    asset: z.string(),
    payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    /** v1 field. */
    maxAmountRequired: z
      .string()
      .regex(/^\d+$/)
      .optional(),
    /** v2 field. */
    amount: z
      .string()
      .regex(/^\d+$/)
      .optional(),
    resource: z.string(),
    description: z.string().optional(),
    maxTimeoutSeconds: z.number().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((r) => r.amount !== undefined || r.maxAmountRequired !== undefined, {
    message: 'an offer needs amount (v2) or maxAmountRequired (v1)',
  });

/** The subset of the x402 payment-required body we act on, validated strictly. */
export const PaymentRequiredSchema = z.object({
  x402Version: z.union([z.literal(1), z.literal(2)]),
  accepts: z.array(PaymentRequirementSchema).min(1),
  error: z.string().optional(),
});

export type PaymentRequirement = z.infer<typeof PaymentRequirementSchema>;
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

/** The v2 proof we put in `X-PAYMENT`: base64(JSON). */
export interface PaymentPayload {
  x402Version: 2;
  scheme: 'exact';
  network: string;
  payload: { txHash: string; from?: string };
}

export const encodePayment = (p: PaymentPayload): string => Buffer.from(JSON.stringify(p), 'utf8').toString('base64');

/** Parses an `X-PAYMENT` header that may be a v2 base64 payload or a bare tx hash. */
export function decodePayment(header: string): PaymentPayload | null {
  const raw = header.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return { x402Version: 2, scheme: 'exact', network: '', payload: { txHash: raw } };
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const p = parsed as Partial<PaymentPayload>;
      const hash = p.payload?.txHash;
      if (typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
        return { x402Version: 2, scheme: 'exact', network: String(p.network ?? ''), payload: { txHash: hash, from: p.payload?.from } };
      }
    }
  } catch {
    // not JSON: fall through
  }
  return null;
}

export interface X402Deps {
  fetchFn: typeof fetch;
  /** Runs the payment through the real executor (policy engine + approval). */
  execute: (intent: { kind: 'native_transfer'; to: Address; amount: string }) => Promise<{
    status: string;
    txHash?: string;
    error?: string;
    decision: { tier: string; reasons: string[] };
  }>;
  /** Chain name, e.g. "Base Sepolia" (kept for servers that send names). */
  network: string;
  /** CAIP-2 id of the wallet's chain, e.g. "eip155:84532" (preferred match). */
  caip2?: string;
  /** Payer address, echoed in the payment payload when known. */
  from?: string;
  symbol: string;
}

export interface X402Result {
  error?: string;
  tier?: string;
  paid?: string;
  txHash?: string;
  /** Non-terminal: the payment was broadcast but the resource has not settled it yet. Never retry. */
  status?: 'settlement_pending';
  data?: unknown;
}

/** Prefers an offer on our chain (exact CAIP-2, then bare chain id, then name). */
function pickOffer(accepts: PaymentRequirement[], deps: X402Deps): PaymentRequirement {
  const want = deps.caip2?.toLowerCase();
  if (want) {
    const exact = accepts.find((a) => a.network.toLowerCase() === want);
    if (exact) return exact;
  }
  const id = deps.caip2?.split(':')[1];
  const ours = accepts.find(
    (a) => (id !== undefined && (a.network === id || a.network.endsWith(`:${id}`))) || a.network.toLowerCase() === deps.network.toLowerCase(),
  );
  return ours ?? accepts[0]!;
}

/** True when a 402 says the payment was broadcast but not yet settled. */
function isSettlementPending(body: unknown, headers: Headers): boolean {
  if (headers.get('x-settlement-status')?.toLowerCase() === 'settlement_pending') return true;
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return b.status === 'settlement_pending' || b.error === 'settlement_pending';
}

/**
 * Fetches `url`, paying through the policy engine when the server answers 402.
 * `allowedOrigin` is the configured paid-API origin; anything else is refused
 * so the model cannot point the wallet at an arbitrary payee (SSRF guard).
 */
export async function fetchPaidData(url: string, allowedOrigin: string, deps: X402Deps): Promise<X402Result> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { error: 'url must be an absolute URL.' };
  }
  if (parsedUrl.origin !== allowedOrigin) {
    return { error: `Only ${allowedOrigin} is allowed for paid fetches (configure X402_API_URL).` };
  }

  const first = await deps.fetchFn(url, { headers: { accept: 'application/json' } });
  if (first.status !== 402) {
    if (!first.ok) return { error: `HTTP ${first.status} from ${parsedUrl.pathname}.` };
    return { data: await first.json() };
  }

  const parsed = PaymentRequiredSchema.safeParse(await first.json().catch(() => null));
  if (!parsed.success) return { error: 'The 402 body was not a valid x402 payment request.' };
  const offer = pickOffer(parsed.data.accepts, deps);

  // This client pays native ETH only; an ERC-20 offer cannot be honoured as-is.
  if (/^0x[0-9a-fA-F]{40}$/.test(offer.asset)) {
    return { error: `This offer asks for an ERC-20 payment (${offer.asset}); the demo client pays native only.` };
  }
  const amountBase = BigInt(offer.amount ?? offer.maxAmountRequired!);
  const amount = formatEther(amountBase);
  const result = await deps.execute({ kind: 'native_transfer', to: offer.payTo as Address, amount });
  if (result.status !== 'executed' || !result.txHash) {
    return {
      error: `Payment not sent (${result.status}): ${result.error ?? result.decision.reasons.join(' ')}`,
      tier: result.decision.tier,
    };
  }
  const paid = `${amount} ${deps.symbol}`;
  const payment: PaymentPayload = {
    x402Version: 2,
    scheme: 'exact',
    network: offer.network,
    payload: { txHash: result.txHash, ...(deps.from ? { from: deps.from } : {}) },
  };

  const retry = await deps.fetchFn(url, { headers: { accept: 'application/json', 'X-PAYMENT': encodePayment(payment) } });
  const body: unknown = await retry.json().catch(() => null);

  // Broadcast but not final: keep the hash, never retry (a second payment would
  // double-charge). The caller can re-check the hash against the chain.
  if (retry.status === 402 && isSettlementPending(body, retry.headers)) {
    return { status: 'settlement_pending', paid, txHash: result.txHash };
  }
  if (!retry.ok) {
    return { error: `Paid ${paid} (tx ${result.txHash}) but the API answered HTTP ${retry.status}.`, txHash: result.txHash, paid };
  }
  return { paid, txHash: result.txHash, data: body };
}
