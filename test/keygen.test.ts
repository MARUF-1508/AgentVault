import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAgentKey } from '../src/chain/keygen.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'av-keygen-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('agent wallet generation', () => {
  it('creates a key when the env file has none and tightens permissions', () => {
    const dir = tmp();
    const path = join(dir, '.env');
    writeFileSync(path, 'LLM_MODEL=x\n');
    const r = writeAgentKey(path, { force: true });
    expect(r.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(r.previous).toBeNull();
    expect(r.replaced).toBe(true);
    const env = readFileSync(path, 'utf8');
    expect(env).toContain('LLM_MODEL=x');
    expect(env).toMatch(/^AGENT_PRIVATE_KEY=0x[0-9a-f]{64}$/m);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The result is public information only: the key itself is never returned.
    const key = env.match(/^AGENT_PRIVATE_KEY=(0x[0-9a-f]{64})$/m)![1]!;
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it('does not replace an existing key unless forced', () => {
    const dir = tmp();
    const path = join(dir, '.env');
    const first = writeAgentKey(path, { force: true });
    const before = readFileSync(path, 'utf8');
    const again = writeAgentKey(path);
    expect(again.replaced).toBe(false);
    expect(again.address).toBe(first.address);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('replaces the key in place and keeps every other line', () => {
    const dir = tmp();
    const path = join(dir, '.env');
    const first = writeAgentKey(path, { force: true });
    const second = writeAgentKey(path, { force: true });
    expect(second.replaced).toBe(true);
    expect(second.previous).toBe(first.address);
    expect(second.address).not.toBe(first.address);
    const env = readFileSync(path, 'utf8');
    expect(env.match(/^AGENT_PRIVATE_KEY=/gm)).toHaveLength(1);
  });

  it('seeds a new file from the example when one is given', () => {
    const dir = tmp();
    const path = join(dir, '.env');
    writeFileSync(join(dir, '.env.example'), 'CHAIN=base-sepolia\nLLM_MODEL=gpt-4o-mini\n');
    const r = writeAgentKey(path, { fallbackPath: join(dir, '.env.example') });
    expect(r.replaced).toBe(true);
    const env = readFileSync(path, 'utf8');
    expect(env).toContain('CHAIN=base-sepolia');
    expect(env).toContain('LLM_MODEL=gpt-4o-mini');
    expect(env).toMatch(/^AGENT_PRIVATE_KEY=0x[0-9a-f]{64}$/m);
  });
});
