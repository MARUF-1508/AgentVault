import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Minimal RFC 6238 TOTP (SHA-1, 30-second steps), the algorithm every
 * authenticator app speaks. Pure and clock-injected so the RFC test vectors can
 * be replayed in test/totp.test.ts. No dependency needed for ~40 lines.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD_MS = 30_000;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Accepts lowercase and spaces for the convenience of a human pasting a secret. */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]/g, '');
  if (!/^[A-Z2-7]*$/.test(clean)) throw new Error('not a base32 string');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(key: Buffer, counter: number, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The 6-digit code for a base32 secret at a moment in time (default now). */
export function totp(secret: string, nowMs: number = Date.now(), digits = 6): string {
  return hotp(base32Decode(secret), Math.floor(nowMs / TOTP_PERIOD_MS), digits);
}

/**
 * True when `code` matches the step containing `nowMs` or ±`window` steps
 * (the usual tolerance for a slightly-off device clock). Constant-time compare.
 */
export function verifyTotp(secret: string, code: string, nowMs: number = Date.now(), window = 1): boolean {
  const clean = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{6}$`).test(clean)) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(nowMs / TOTP_PERIOD_MS);
  for (let i = -window; i <= window; i++) {
    if (counter + i < 0) continue; // no valid step before the epoch
    const expected = hotp(key, counter + i, 6);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return true;
  }
  return false;
}

/** The otpauth:// URI an authenticator app scans (issuer AgentVault). */
export function otpauthUri(username: string, secret: string): string {
  const label = encodeURIComponent(`AgentVault:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=AgentVault&algorithm=SHA1&digits=6&period=30`;
}
