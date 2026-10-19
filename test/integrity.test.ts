import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPolicy } from '../src/config.js';
import { assertPinnedPolicy, matchesPin, policyFileHash, PolicyIntegrity } from '../src/policy/integrity.js';
import { basePolicy } from './helpers.js';

function policyFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'av-integrity-')), 'policy.json');
  writeFileSync(path, `${JSON.stringify(basePolicy(), null, 2)}\n`);
  return path;
}

describe('policy file integrity (S4)', () => {
  it('accepts the full hash or a 16+ char prefix, and nothing shorter', () => {
    const hash = 'a'.repeat(64);
    expect(matchesPin(hash, hash)).toBe(true);
    expect(matchesPin(hash, 'A'.repeat(16))).toBe(true);
    expect(matchesPin(hash, 'a'.repeat(8))).toBe(false);
    expect(matchesPin(hash, 'b'.repeat(16))).toBe(false);
  });

  it('refuses to load a policy that does not match its pin', () => {
    const path = policyFile();
    const pin = policyFileHash(path);
    expect(loadPolicy(path, pin).chainId).toBe(84532);
    // Someone edits the file by hand: raise the hard cap.
    writeFileSync(path, readFile(path).replace('"0.005"', '"5"'));
    expect(() => loadPolicy(path, pin)).toThrow(/Refusing to start/);
    expect(() => assertPinnedPolicy(path, undefined)).not.toThrow();
  });

  it('reports drift when the file changes behind the running server, until accepted', () => {
    const path = policyFile();
    const integrity = new PolicyIntegrity(path);
    expect(integrity.status()).toMatchObject({ drift: false, pinned: false, matchesPin: null });
    writeFileSync(path, readFile(path).replace('"0.01"', '"1"'));
    expect(integrity.status().drift).toBe(true);
    integrity.accept();
    expect(integrity.status().drift).toBe(false);
  });
});

const readFile = (path: string) => readFileSync(path, 'utf8');
