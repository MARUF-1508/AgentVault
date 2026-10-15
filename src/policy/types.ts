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

/**
 * DEX rules for the `swap` intent. Swap is disabled unless this block is present,
 * so a wallet with no swap config refuses every swap (deny by default).
 */
const SwapRules = z.object({
  /** The only router the agent may call. */
  router: Address,
  /** Read-only quoter used to price a swap off-chain (never signs). */
  quoter: Address,
  /** Pool fee tier in hundredths of a bip (3000 = 0.30%). */
  feeTier: z.number().int().positive(),
  /** Hard ceiling on slippage the agent may ever request, in basis points. */
  maxSlippageBps: z.number().int().min(1).max(10_000),
  /** Above this, a swap needs a human. */
  autoMaxSlippageBps: z.number().int().min(0).max(10_000),
});

/** How to value an asset in USD. Uses the Chainlink feed when set, else the labelled fallback. */
const PriceRules = z.object({
  /** Optional Chainlink AggregatorV3 proxy. Falls back if unset or the read fails. */
  chainlinkFeed: Address.optional(),
  /** Clearly-labelled fallback USD price for testnet, as a decimal string. */
  fallbackUsd: Decimal,
});

/**
 * Day 3 risk controls. Opt-in: an absent block disables the anomaly guard and
 * treats non-allowlisted contract recipients as "confirm" (T2).
 */
const RiskRules = z.object({
  /** Refuse a single action worth more than this share (0-100) of the portfolio. 0 disables. */
  maxActionPctOfPortfolio: z.number().min(0).max(100).default(50),
  /** What to do with a non-allowlisted recipient that has contract code. */
  contractRecipients: z.enum(['allow', 'confirm', 'deny']).default('confirm'),
  /** Local block list of known-bad addresses (scams, exploiters). */
  blocklist: z.array(Address).default([]),
  /** Detect an address that imitates an allowlisted one (address poisoning). */
  lookalike: z
    .object({
      enabled: z.boolean().default(true),
      /** Shared leading hex digits required to flag a lookalike. */
      prefix: z.number().int().min(0).max(20).default(4),
      /** Shared trailing hex digits required to flag a lookalike. */
      suffix: z.number().int().min(0).max(20).default(4),
    })
    .default({ enabled: true, prefix: 4, suffix: 4 }),
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
  /** Optional: absent means swaps are refused. */
  swap: SwapRules.optional(),
  /** Optional: per-symbol USD valuation for the portfolio view. */
  prices: z.record(z.string(), PriceRules).default({}),
  /** Optional Day 3 risk controls (anomaly guard, block list, lookalikes, contracts). */
  risk: RiskRules.optional(),
  rateLimit: z.object({ maxTxPerHour: z.number().int().positive() }),
});

export type Policy = z.infer<typeof PolicySchema>;

/** Everything the agent can ask the wallet to do that changes state on-chain. */
export type Intent =
  | { kind: 'native_transfer'; to: `0x${string}`; amount: string }
  | { kind: 'erc20_transfer'; token: string; to: `0x${string}`; amount: string }
  | { kind: 'erc20_approve'; token: string; spender: `0x${string}`; amount: string | 'unlimited' }
  | { kind: 'swap'; tokenIn: string; tokenOut: string; amountIn: string; slippageBps: number; router?: `0x${string}` };

const NativeTransferIntent = z.object({ kind: z.literal('native_transfer'), to: Address, amount: Decimal });
const Erc20TransferIntent = z.object({ kind: z.literal('erc20_transfer'), token: z.string(), to: Address, amount: Decimal });
const Erc20ApproveIntent = z.object({
  kind: z.literal('erc20_approve'),
  token: z.string(),
  spender: Address,
  amount: z.union([Decimal, z.literal('unlimited')]),
});
const SwapIntent = z.object({
  kind: z.literal('swap'),
  tokenIn: z.string(),
  tokenOut: z.string(),
  amountIn: Decimal,
  // Required on purpose: a swap without an explicit slippage cap is refused.
  slippageBps: z.number().int().min(0).max(10_000),
  router: Address.optional(),
});

/**
 * Transfers and approvals only. This is the schema the generic
 * preview/execute tools accept, so a model cannot smuggle a swap past the
 * `execute_swap` orchestration (which sends the bounded approval first).
 */
export const ActionIntentSchema = z.discriminatedUnion('kind', [
  NativeTransferIntent,
  Erc20TransferIntent,
  Erc20ApproveIntent,
]);

export const SwapIntentSchema = SwapIntent;

/** The full union, for the executor, CLI and policy engine. */
export const IntentSchema = z.discriminatedUnion('kind', [
  NativeTransferIntent,
  Erc20TransferIntent,
  Erc20ApproveIntent,
  SwapIntent,
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
  /** Swaps only: minimum acceptable output, in base units of `tokenOut`. */
  minAmountOut?: bigint;
  /** Swaps only: the router that will be called. */
  router?: `0x${string}`;
}

/**
 * Chain-derived market data the engine cannot fetch itself (it must stay pure).
 * The executor quotes the DEX before `evaluate` and passes it in, the same way it
 * passes SpendState. A missing/zero quote makes the engine refuse the swap.
 */
export interface SwapMarket {
  /** Quoted output for the swap, in base units of `tokenOut`. */
  amountOut: bigint;
}

/** Spend history the engine needs; derived from the audit log. */
export interface SpendState {
  /** asset symbol -> base units confirmed today (UTC). */
  spentToday: Record<string, bigint>;
  txLastHour: number;
  paused: boolean;
  /** Optional Day 3 risk findings; missing means those checks stay off. */
  risk?: RiskInput;
}

/**
 * Address-risk findings for one target. Computed by `src/risk/address.ts` (which
 * may read chain state) and passed in, so the engine remains a pure function
 * while still being able to *raise* a tier.
 */
export interface AddressRisk {
  /** True when the address has contract code, or we could not prove otherwise. */
  isContract: boolean;
  /** True when the address is on the policy's local block list. */
  onBlocklist: boolean;
  /** An allowlisted address this one imitates (address poisoning), if any. */
  lookalikeOf?: `0x${string}`;
}

/**
 * Chain-derived inputs for the risk checks. The executor computes these before
 * calling `evaluate`; a missing field simply leaves that check off.
 */
export interface RiskInput {
  recipient?: AddressRisk;
  /** Whole-portfolio value in USD, 8 decimal places. */
  portfolioUsd?: bigint;
  /** USD value of this request's amount, 8 decimal places. */
  amountUsd?: bigint;
}
