import { decodeFunctionData, erc20Abi, formatUnits, type Abi, type Hex } from 'viem';
import { decodeAnchor } from '../audit/anchor.js';
import { agentVaultV2Abi } from '../chain/vault.js';
import { SWAP_ROUTER_02_ABI } from '../dex/uniswap.js';
import type { Policy } from '../policy/types.js';

/** A transaction as it will be signed. */
export interface TxRequest {
  to: `0x${string}`;
  value: bigint;
  data?: Hex;
}

const KNOWN: { name: string; abi: Abi }[] = [
  { name: 'ERC-20', abi: erc20Abi as Abi },
  { name: 'AgentVault', abi: agentVaultV2Abi as Abi },
  { name: 'SwapRouter02', abi: SWAP_ROUTER_02_ABI as Abi },
];

const show = (v: unknown): string => {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${show(x)}`).join(', ')} }`;
  return String(v);
};

/**
 * Decodes the exact calldata that will be signed (S6), so the human approval
 * card shows the real call rather than the model's description of it. Decoding
 * runs on the bytes the executor built, so a mismatch between "what the card
 * says" and "what is signed" cannot arise from the model.
 */
export function decodeCall(req: TxRequest, policy: Policy): string {
  const value = req.value > 0n ? ` with ${formatUnits(req.value, 18)} ${policy.native.symbol}` : '';
  if (!req.data || req.data === '0x') return `plain transfer to ${req.to}${value}`;
  const anchor = decodeAnchor(req.data);
  if (anchor) return `audit anchor (entry #${anchor.seq}, head ${anchor.headHash.slice(0, 16)}…) to ${req.to}`;
  for (const { name, abi } of KNOWN) {
    try {
      const { functionName, args } = decodeFunctionData({ abi, data: req.data });
      return `${name}.${functionName}(${(args ?? []).map(show).join(', ')}) on ${req.to}${value}`;
    } catch {
      // try the next ABI
    }
  }
  return `unknown call ${req.data.slice(0, 10)} on ${req.to}${value}`;
}
