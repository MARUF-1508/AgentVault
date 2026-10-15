import { z } from 'zod';
import { getAddress, isAddress } from 'viem';

const Address = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), 'not a valid address')
  .transform((s) => getAddress(s));

const Decimal = z.string().regex(/^\d+(\.\d+)?$/, 'decimal string, e.g. "0.01"');

const Limits = z.object({
  /** At or below this amount (and to a known recipient) the agent may act on its own. */
  autoMaxPerTx: Decimal,
  /** Above this amount the transaction is refused outright, even with human approval. */
  hardMaxPerTx: Decimal,
  /** Total confirmed spend per UTC day across all transactions of this asset. */
  dailyBudget: Decimal,
});

export const PolicySchema = z.object({
  version: z.literal(1),
  chainId: z.number().int().positive(),
  native: Limits.extend({ symbol: z.string() }),
  tokens: z.record(z.string(), Limits.extend({ address: Address, decimals: z.number().int().min(0).max(36) })),
  recipients: z.object({
    /** label -> address. Known recipients can receive auto-tier transfers. */
    allowlist: z.record(z.string(), Address),
    denylist: z.array(Address),
  }),
  approvals: z.object({
    allowUnlimited: z.boolean(),
    /** label -> address of contracts that may receive ERC-20 allowances. */
    spenderAllowlist: z.record(z.string(), Address),
  }),
  rateLimit: z.object({ maxTxPerHour: z.number().int().positive() }),
});

export type Policy = z.infer<typeof PolicySchema>;

/** Everything the agent can ask the wallet to do that changes state on-chain. */
export type Intent =
  | { kind: 'native_transfer'; to: `0x${string}`; amount: string }
  | { kind: 'erc20_transfer'; token: string; to: `0x${string}`; amount: string }
  | { kind: 'erc20_approve'; token: string; spender: `0x${string}`; amount: string | 'unlimited' };

export const IntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native_transfer'), to: Address, amount: Decimal }),
  z.object({ kind: z.literal('erc20_transfer'), token: z.string(), to: Address, amount: Decimal }),
  z.object({
    kind: z.literal('erc20_approve'),
    token: z.string(),
    spender: Address,
    amount: z.union([Decimal, z.literal('unlimited')]),
  }),
]);

/**
 * Permission tiers.
 * T0 read-only: never reaches the policy engine (balances, quotes, history).
 * T1 auto:      executes without a human, inside tight limits.
 * T2 confirm:   a human must approve this specific transaction.
 * T3 deny:      refused regardless of who asks.
 */
export type Tier = 'T1_AUTO' | 'T2_CONFIRM' | 'T3_DENY';

export interface Decision {
  tier: Tier;
  reasons: string[];
  /** Amount in base units (wei / token units) used for budget accounting. */
  amountBase: bigint;
  asset: string;
}

/** Spend history the engine needs; derived from the audit log. */
export interface SpendState {
  /** asset symbol -> base units confirmed today (UTC). */
  spentToday: Record<string, bigint>;
  txLastHour: number;
  paused: boolean;
}
