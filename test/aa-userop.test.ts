import { decodeFunctionData, parseEther, recoverMessageAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  buildSessionUserOp,
  ENTRYPOINT_V07,
  getUserOpHash,
  packUint128s,
  sessionKeyAccountAbi,
  sessionScopeFromPolicy,
} from '../src/aa/userop.js';
import { VECTOR_OP } from '../scripts/userop-vector.js';
import { ALICE, basePolicy } from './helpers.js';

describe('ERC-4337 session-key user operations (B2)', () => {
  it('hashes exactly like EntryPoint v0.7 (same vector as the Foundry test)', () => {
    expect(getUserOpHash(VECTOR_OP, ENTRYPOINT_V07, 84532)).toBe('0x4687b2b1383fb17ed174794aa26a060fadf872e1322a5f62007ef5e65d28dc44');
    // The signature is not part of the hash; the chain id and EntryPoint are.
    expect(getUserOpHash({ ...VECTOR_OP, signature: '0xdead' }, ENTRYPOINT_V07, 84532)).toBe(getUserOpHash(VECTOR_OP, ENTRYPOINT_V07, 84532));
    expect(getUserOpHash(VECTOR_OP, ENTRYPOINT_V07, 1)).not.toBe(getUserOpHash(VECTOR_OP, ENTRYPOINT_V07, 84532));
  });

  it('packs two uint128 gas values high-then-low and refuses overflow', () => {
    expect(packUint128s(150000n, 100000n)).toBe('0x000000000000000000000000000249f0000000000000000000000000000186a0');
    expect(() => packUint128s(1n << 128n, 0n)).toThrow();
    expect(() => packUint128s(-1n, 0n)).toThrow();
  });

  it('builds execute(target, value, data) and signs the hash with the session key (EIP-191)', async () => {
    const sessionKey = privateKeyToAccount(generatePrivateKey());
    const { userOp, userOpHash } = await buildSessionUserOp({
      sender: '0x1111111111111111111111111111111111111111',
      nonce: 0n,
      target: ALICE,
      value: parseEther('0.0005'),
      sessionKey,
      chainId: 84532,
    });
    const call = decodeFunctionData({ abi: sessionKeyAccountAbi, data: userOp.callData });
    expect(call.functionName).toBe('execute');
    expect(call.args).toEqual([ALICE, parseEther('0.0005'), '0x']);
    expect(userOpHash).toBe(getUserOpHash(userOp, ENTRYPOINT_V07, 84532));
    // What SessionKeyAccount.validateUserOp recovers: the session key's address.
    expect(await recoverMessageAddress({ message: { raw: userOpHash }, signature: userOp.signature })).toBe(sessionKey.address);
    expect(userOp.signature.length).toBe(132); // 65 bytes
  });

  it('derives the on-chain session scope from the off-chain policy', () => {
    const scope = sessionScopeFromPolicy(basePolicy(), { now: new Date('2026-10-19T00:00:00Z'), hours: 24 });
    expect(scope).toEqual({
      validUntil: Math.floor(Date.parse('2026-10-20T00:00:00Z') / 1000),
      maxPerOp: parseEther('0.001'),
      maxTotal: parseEther('0.01'),
      targets: [ALICE],
      selectors: ['0x00000000'],
    });
  });
});
