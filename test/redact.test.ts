import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSecrets, redact, redactText, registerSecret, REDACTED } from '../src/audit/redact.js';
import { harness } from './helpers.js';

// A fresh random key per run: no key material is committed, even a test one.
const KEY = generatePrivateKey();

afterEach(() => clearSecrets());

describe('secret redaction (S8)', () => {
  it('blanks fields that are secret by name, at any depth', () => {
    const out = redact({ user: 'olivia', password: 'hunter2hunter2', nested: { apiKey: 'abc', privateKey: KEY }, list: [{ secret: 1 }] });
    expect(out).toEqual({ user: 'olivia', password: REDACTED, nested: { apiKey: REDACTED, privateKey: REDACTED }, list: [{ secret: REDACTED }] });
  });

  it('scrubs a registered secret wherever it appears, with or without 0x and in any case', () => {
    registerSecret(KEY);
    expect(redactText(`boom: invalid key ${KEY}`)).toBe(`boom: invalid key ${REDACTED}`);
    expect(redactText(`raw ${KEY.slice(2).toUpperCase()}`)).toBe(`raw ${REDACTED}`);
  });

  it('scrubs API-key and bearer-token shapes even when nothing was registered', () => {
    expect(redactText('auth failed for sk-proj-ABCDEFGHIJKLMNOPQRSTUV')).toBe(`auth failed for ${REDACTED}`);
    expect(redactText('Authorization: Bearer abcdefghijklmnop1234')).toContain(REDACTED);
  });

  it('keeps transaction hashes and addresses intact (they are evidence, not secrets)', () => {
    registerSecret(KEY);
    const hash = `0x${'a'.repeat(64)}`;
    expect(redact({ hash, to: '0x4785Dca37A242F3D80f844CB0b143A687008a2B5' })).toEqual({
      hash,
      to: '0x4785Dca37A242F3D80f844CB0b143A687008a2B5',
    });
  });

  it('the audit file never contains the agent key, even when an RPC error echoes it', async () => {
    registerSecret(KEY);
    const { executor, clients, dir } = harness();
    // Simulate a library error message that (wrongly) includes the key.
    (clients.walletClient as unknown as { sendTransaction: () => Promise<never> }).sendTransaction = async () => {
      throw new Error(`signer rejected key ${KEY}`);
    };
    const r = await executor.execute({ kind: 'native_transfer', to: '0x4785Dca37A242F3D80f844CB0b143A687008a2B5', amount: '0.0001' });
    expect(r.status).toBe('simulation_failed');
    const file = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    expect(file).toContain('tx_failed');
    expect(file.toLowerCase()).not.toContain(KEY.slice(2).toLowerCase());
    expect(file).toContain(REDACTED);
  });
});
