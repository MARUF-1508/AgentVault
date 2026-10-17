import { formatEther, type Address } from 'viem';
import { z } from 'zod';

/**
 * x402-style paid API client. When a resource answers HTTP 402, the wallet pays
 * the advertised price and retries once with the tx hash as proof. The payment
 * goes through Executor.execute like every other spending action, so the policy
 * engine (and possibly a human) decides whether it happens at all.
 */

/** The subset of the x402 payment-required body we act on, validated strictly. */
export const PaymentRequiredSchema = z.object({
  x402Version: z.number(),
  accepts: z
    .array(
      z.object({
        scheme: z.literal('exact'),
        network: z.string(),
        asset: z.string(),
        payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        maxAmountRequired: z.string().regex(/^\d+$/),
        resource: z.string(),
        description: z.string().optional(),
        maxTimeoutSeconds: z.number().optional(),
      }),
    )
    .min(1),
});

export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

export interface X402Deps {
  fetchFn: typeof fetch;
  /** Runs the payment through the real executor (policy engine + approval). */
  execute: (intent: { kind: 'native_transfer'; to: Address; amount: string }) => Promise<{
    status: string;
    txHash?: string;
    error?: string;
    decision: { tier: string; reasons: string[] };
  }>;
  network: string;
  symbol: string;
}

export interface X402Result {
  error?: string;
  tier?: string;
  paid?: string;
  txHash?: string;
  data?: unknown;
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
  const offer =
    parsed.data.accepts.find((a) => a.network === deps.network || a.network.includes('84532')) ?? parsed.data.accepts[0]!;

  const amount = formatEther(BigInt(offer.maxAmountRequired));
  const result = await deps.execute({ kind: 'native_transfer', to: offer.payTo as Address, amount });
  if (result.status !== 'executed' || !result.txHash) {
    return {
      error: `Payment not sent (${result.status}): ${result.error ?? result.decision.reasons.join(' ')}`,
      tier: result.decision.tier,
    };
  }

  const retry = await deps.fetchFn(url, { headers: { accept: 'application/json', 'x-payment': result.txHash } });
  const body: unknown = await retry.json().catch(() => null);
  if (!retry.ok) {
    return { error: `Paid ${amount} ${deps.symbol} (tx ${result.txHash}) but the API answered HTTP ${retry.status}.`, txHash: result.txHash };
  }
  return { paid: `${amount} ${deps.symbol}`, txHash: result.txHash, data: body };
}
