import { encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';

/**
 * Uniswap v3 periphery used for the `swap` intent on Base Sepolia.
 * QuoterV2 is read-only from our side (called via eth_call); SwapRouter02 is the
 * only contract we ever grant an allowance to. Addresses live in `config/policy.json`.
 */
export const QUOTER_V2_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'quoteExactInputSingle',
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
    // Declared view so viem exposes it through readContract (eth_call); the on-chain
    // function is nonpayable but has no lasting state effect.
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const SWAP_ROUTER_02_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'exactInputSingle',
    outputs: [{ name: 'amountOut', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

export interface SwapParams {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
}

/** Price a single-hop swap. Read-only: goes through eth_call, never signs. */
export async function quoteExactInputSingle(client: PublicClient, quoter: Address, p: SwapParams): Promise<bigint> {
  const result = await client.readContract({
    address: quoter,
    abi: QUOTER_V2_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: p.amountIn, fee: p.fee, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

export interface SwapCalldataParams extends SwapParams {
  recipient: Address;
  /** Minimum acceptable output. Derived by the policy engine, never by the LLM. */
  amountOutMinimum: bigint;
}

/** ABI-encode the router call. The recipient always receives the output directly. */
export function encodeSwapCalldata(p: SwapCalldataParams): Hex {
  return encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: p.tokenIn,
        tokenOut: p.tokenOut,
        fee: p.fee,
        recipient: p.recipient,
        amountIn: p.amountIn,
        amountOutMinimum: p.amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}
