import { encodeExecute, ENTRYPOINT_V07, getUserOpHash, packUint128s, type PackedUserOperation } from '../src/aa/userop.js';

/**
 * Prints the fixed ERC-4337 v0.7 user-operation vector that both
 * test/aa-userop.test.ts and test/contracts/SessionKeyAccount.t.sol assert, so
 * the TypeScript helper and the Solidity hash formula are checked against each other.
 */
export const VECTOR_OP: PackedUserOperation = {
  sender: '0x1111111111111111111111111111111111111111',
  nonce: 7n,
  initCode: '0x',
  callData: encodeExecute('0x4785Dca37A242F3D80f844CB0b143A687008a2B5', 500000000000000n, '0x'),
  accountGasLimits: packUint128s(150000n, 100000n),
  preVerificationGas: 50000n,
  gasFees: packUint128s(1000000n, 2000000000n),
  paymasterAndData: '0x',
  signature: '0x',
};

if (process.argv[1]?.endsWith('userop-vector.ts')) {
  console.log('callData        ', VECTOR_OP.callData);
  console.log('accountGasLimits', VECTOR_OP.accountGasLimits);
  console.log('gasFees         ', VECTOR_OP.gasFees);
  console.log('userOpHash      ', getUserOpHash(VECTOR_OP, ENTRYPOINT_V07, 84532));
}
