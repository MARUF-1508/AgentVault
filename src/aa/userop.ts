import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseEther,
  toHex,
  type Hex,
  type LocalAccount,
} from 'viem';
import type { Policy } from '../policy/types.js';

/**
 * ERC-4337 (EntryPoint v0.7) helpers for `contracts/SessionKeyAccount.sol` (B2).
 *
 * The agent holds only a session key. It builds a user operation that calls
 * `execute(target, value, data)` on the smart account and signs the EntryPoint's
 * user-operation hash with EIP-191, which is exactly what the account's
 * `validateUserOp` recovers. The account refuses anything outside the session's
 * scope, so these helpers never decide policy; the off-chain engine still runs
 * first and the contract re-checks on-chain.
 *
 * Tested against fixed vectors that the Foundry tests reproduce in Solidity.
 * Not yet used against a live bundler (see docs/FINAL_STATUS.md).
 */

/** The canonical EntryPoint v0.7 address (same on every chain, incl. Base Sepolia). */
export const ENTRYPOINT_V07: `0x${string}` = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

export const sessionKeyAccountAbi = [
  {
    name: 'execute',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'grantSession',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'key', type: 'address' },
      { name: 'validUntil', type: 'uint48' },
      { name: 'maxPerOp', type: 'uint128' },
      { name: 'maxTotal', type: 'uint128' },
      { name: 'targets', type: 'address[]' },
      { name: 'selectors', type: 'bytes4[]' },
    ],
    outputs: [],
  },
  {
    name: 'revokeSession',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'key', type: 'address' }],
    outputs: [],
  },
] as const;

/** v0.7 PackedUserOperation, as the EntryPoint takes it. */
export interface PackedUserOperation {
  sender: `0x${string}`;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  /** verificationGasLimit (high 128 bits) | callGasLimit (low 128 bits). */
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  /** maxPriorityFeePerGas (high 128 bits) | maxFeePerGas (low 128 bits). */
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

const MAX_128 = (1n << 128n) - 1n;

/** Packs two uint128 values into one bytes32, high then low (v0.7 layout). */
export function packUint128s(high: bigint, low: bigint): Hex {
  if (high < 0n || low < 0n || high > MAX_128 || low > MAX_128) throw new Error('gas values must fit in uint128');
  return toHex((high << 128n) | low, { size: 32 });
}

/** Calldata for `execute(target, value, data)` on the smart account. */
export function encodeExecute(target: `0x${string}`, value: bigint, data: Hex = '0x'): Hex {
  return encodeFunctionData({ abi: sessionKeyAccountAbi, functionName: 'execute', args: [target, value, data] });
}

/** EntryPoint v0.7 `getUserOpHash`: keccak(abi.encode(keccak(packed fields), entryPoint, chainId)). */
export function getUserOpHash(op: PackedUserOperation, entryPoint: `0x${string}`, chainId: number): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        op.sender,
        op.nonce,
        keccak256(op.initCode),
        keccak256(op.callData),
        op.accountGasLimits,
        op.preVerificationGas,
        op.gasFees,
        keccak256(op.paymasterAndData),
      ],
    ),
  );
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }], [inner, entryPoint, BigInt(chainId)]));
}

/**
 * Builds and signs a session-key operation that calls `target` with `value` and
 * `data` from the smart account. The signature is EIP-191 over the user-op hash,
 * which `SessionKeyAccount.validateUserOp` recovers.
 */
export async function buildSessionUserOp(args: {
  sender: `0x${string}`;
  nonce: bigint;
  target: `0x${string}`;
  value: bigint;
  data?: Hex;
  sessionKey: LocalAccount;
  chainId: number;
  entryPoint?: `0x${string}`;
  gas?: { verificationGasLimit: bigint; callGasLimit: bigint; preVerificationGas: bigint; maxPriorityFeePerGas: bigint; maxFeePerGas: bigint };
}): Promise<{ userOp: PackedUserOperation; userOpHash: Hex }> {
  const gas = args.gas ?? {
    verificationGasLimit: 150_000n,
    callGasLimit: 100_000n,
    preVerificationGas: 50_000n,
    maxPriorityFeePerGas: 1_000_000n,
    maxFeePerGas: 2_000_000_000n,
  };
  const userOp: PackedUserOperation = {
    sender: args.sender,
    nonce: args.nonce,
    initCode: '0x',
    callData: encodeExecute(args.target, args.value, args.data ?? '0x'),
    accountGasLimits: packUint128s(gas.verificationGasLimit, gas.callGasLimit),
    preVerificationGas: gas.preVerificationGas,
    gasFees: packUint128s(gas.maxPriorityFeePerGas, gas.maxFeePerGas),
    paymasterAndData: '0x',
    signature: '0x',
  };
  const userOpHash = getUserOpHash(userOp, args.entryPoint ?? ENTRYPOINT_V07, args.chainId);
  if (!args.sessionKey.signMessage) throw new Error('The session key cannot sign messages.');
  userOp.signature = await args.sessionKey.signMessage({ message: { raw: userOpHash } });
  return { userOp, userOpHash };
}

/**
 * A session scope that mirrors the off-chain policy: native transfers only
 * (selector 0x00000000) to the allowlisted recipients, at most the auto limit
 * per operation and the daily budget in total, valid for `hours`.
 * Pass the result to `grantSession` from the owner key.
 */
export function sessionScopeFromPolicy(policy: Policy, opts: { now?: Date; hours?: number } = {}) {
  const now = opts.now ?? new Date();
  const hours = opts.hours ?? 24;
  return {
    validUntil: Math.floor(now.getTime() / 1000) + Math.round(hours * 3600),
    maxPerOp: parseEther(policy.native.autoMaxPerTx),
    maxTotal: parseEther(policy.native.dailyBudget),
    targets: [...new Set(Object.values(policy.recipients.allowlist))] as `0x${string}`[],
    selectors: ['0x00000000'] as Hex[],
  };
}
