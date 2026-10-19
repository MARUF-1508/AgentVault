import { erc20Abi, formatEther, formatUnits, parseUnits, type Address } from 'viem';
import type { Clients } from '../chain/client.js';
import type { Policy } from '../policy/types.js';
import { getUsdPrice, usdValueBase, USD_SCALE, type PriceSource } from '../prices/price.js';

export interface Holding {
  asset: string;
  kind: 'native' | 'erc20';
  /** Human-readable balance, decimal string. */
  balance: string;
  /** Human-readable USD price and value, when a price is configured. */
  usdPrice?: string;
  usdValue?: string;
  priceSource?: PriceSource;
  /** Set when this asset's balance could not be read (RPC failure); the rest still loads. */
  error?: string;
}

export interface Portfolio {
  address: string | null;
  chain: string;
  chainId: number;
  holdings: Holding[];
  /** Sum of the priced holdings, human-readable USD decimal string. */
  totalUsd: string;
}

/** USD value of `balanceBase` (units of 10^decimals) at `usdPrice`, or undefined if the price is unusable. */
function usdValue(balanceBase: bigint, decimals: number, usdPrice: string): string | undefined {
  const v = usdValueBase(balanceBase, decimals, usdPrice);
  return v === undefined ? undefined : formatUnits(v, USD_SCALE);
}

/**
 * T0 read-only portfolio: every policy asset's balance plus a clearly-labelled USD
 * valuation. No signing, no approval; safe for the agent to call at any time.
 */
export async function getPortfolio(clients: Clients, policy: Policy): Promise<Portfolio> {
  const { publicClient, account, chain } = clients;
  const address = account?.address ?? null;
  const base: Portfolio = { address, chain: chain.name, chainId: chain.id, holdings: [], totalUsd: '0' };
  if (!address) return base;

  let total = 0n;

  const nativeBalance = await publicClient.getBalance({ address });
  const nativePrice = await getUsdPrice(publicClient, policy, policy.native.symbol);
  const nativeValue = nativePrice ? usdValue(nativeBalance, 18, nativePrice.usdPrice) : undefined;
  if (nativeValue) total += parseUnits(nativeValue, USD_SCALE);
  base.holdings.push({
    asset: policy.native.symbol,
    kind: 'native',
    balance: formatEther(nativeBalance),
    usdPrice: nativePrice?.usdPrice,
    usdValue: nativeValue,
    priceSource: nativePrice?.source,
  });

  for (const [symbol, token] of Object.entries(policy.tokens)) {
    let raw: bigint;
    try {
      raw = await publicClient.readContract({
        address: token.address as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      });
    } catch (err) {
      // Availability: one unreadable token must not hide every other balance.
      base.holdings.push({ asset: symbol, kind: 'erc20', balance: '0', error: `Balance unavailable: ${shortMessage(err)}` });
      continue;
    }
    const price = await getUsdPrice(publicClient, policy, symbol);
    const value = price ? usdValue(raw, token.decimals, price.usdPrice) : undefined;
    if (value) total += parseUnits(value, USD_SCALE);
    base.holdings.push({
      asset: symbol,
      kind: 'erc20',
      balance: formatUnits(raw, token.decimals),
      usdPrice: price?.usdPrice,
      usdValue: value,
      priceSource: price?.source,
    });
  }

  base.totalUsd = formatUnits(total, USD_SCALE);
  return base;
}

function shortMessage(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e.shortMessage ?? e.message ?? String(err)).split('\n')[0]!.slice(0, 160);
}
