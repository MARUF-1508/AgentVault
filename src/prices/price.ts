import { formatUnits, parseUnits, type PublicClient } from 'viem';
import type { Policy } from '../policy/types.js';

/** Chainlink AggregatorV3, read-only. */
const AGGREGATOR_V3_ABI = [
  { inputs: [], name: 'decimals', outputs: [{ type: 'uint8' }], stateMutability: 'view', type: 'function' },
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export type PriceSource = 'chainlink' | 'fixed-testnet-table';

/** Fixed-point scale used for all USD values (bigint base units). */
export const USD_SCALE = 8;

/**
 * Value `balanceBase` (units of 10^decimals) at `usdPrice` as a bigint in USD
 * base units (10^USD_SCALE). Returns undefined when either input is unusable.
 */
export function usdValueBase(balanceBase: bigint, decimals: number, usdPrice: string): bigint | undefined {
  try {
    const priceScaled = parseUnits(usdPrice, USD_SCALE);
    return (balanceBase * priceScaled) / 10n ** BigInt(decimals);
  } catch {
    return undefined;
  }
}

export interface PriceQuote {
  asset: string;
  /** Human-readable decimal USD price, e.g. "2500.12". */
  usdPrice: string;
  source: PriceSource;
}

/**
 * USD valuation for one asset. Prefers a configured Chainlink feed (real oracle
 * data) and falls back to the clearly-labelled testnet table when the feed is
 * unset or the read fails. Never affects signing: the portfolio is T0 read-only.
 */
export async function getUsdPrice(
  publicClient: PublicClient,
  policy: Policy,
  symbol: string,
): Promise<PriceQuote | undefined> {
  const entry = Object.entries(policy.prices).find(([k]) => k.toLowerCase() === symbol.toLowerCase());
  if (!entry) return undefined;
  const rules = entry[1];

  if (rules.chainlinkFeed) {
    try {
      const [decimals, round] = await Promise.all([
        publicClient.readContract({ address: rules.chainlinkFeed, abi: AGGREGATOR_V3_ABI, functionName: 'decimals' }),
        publicClient.readContract({ address: rules.chainlinkFeed, abi: AGGREGATOR_V3_ABI, functionName: 'latestRoundData' }),
      ]);
      const answer = round[1];
      if (answer > 0n) return { asset: symbol, usdPrice: formatUnits(answer, decimals), source: 'chainlink' };
    } catch {
      // Fall through to the labelled fallback rather than failing the portfolio.
    }
  }
  return { asset: symbol, usdPrice: rules.fallbackUsd, source: 'fixed-testnet-table' };
}
