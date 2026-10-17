import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totp, verifyTotp } from '../src/auth/totp.js';

// RFC 6238 Appendix B: SHA-1, seed "12345678901234567890" (ASCII).
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totp (RFC 6238)', () => {
  it('matches every published SHA-1 test vector (8 digits)', () => {
    const vectors: Array<[seconds: number, expected: string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, expected] of vectors) {
      expect(totp(SEED, seconds * 1000, 8)).toBe(expected);
    }
  });

  it('produces 6-digit codes by default', () => {
    expect(totp(SEED, 59_000)).toBe('287082');
    expect(verifyTotp(SEED, ' 287 082 ', 59_000)).toBe(true);
  });

  it('accepts the neighbouring step for clock skew, but not a whole step further', () => {
    expect(verifyTotp(SEED, '287082', 59_000 + 30_000)).toBe(true);
    expect(verifyTotp(SEED, '287082', 59_000 - 30_000)).toBe(true);
    expect(verifyTotp(SEED, '287082', 59_000 + 60_000)).toBe(false);
  });

  it('rejects empty, short, long and non-numeric codes', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5x']) {
      expect(verifyTotp(SEED, bad, 59_000)).toBe(false);
    }
  });

  it('round-trips base32 and generates valid secrets', () => {
    expect(base32Encode(Buffer.from('12345678901234567890'))).toBe(SEED);
    expect(base32Decode(SEED).toString()).toBe('12345678901234567890');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(base32Decode(SEED));
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(verifyTotp(secret, totp(secret))).toBe(true);
  });

  it('builds an otpauth URI an authenticator app can scan', () => {
    const uri = otpauthUri('olivia', SEED);
    expect(uri).toBe(
      `otpauth://totp/AgentVault%3Aolivia?secret=${SEED}&issuer=AgentVault&algorithm=SHA1&digits=6&period=30`,
    );
  });
});
