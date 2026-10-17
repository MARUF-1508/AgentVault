import { describe, expect, it } from 'vitest';
import { resolveRecipient } from '../src/agent/resolve.js';
import { runTool, toolDefinitions, type ToolContext } from '../src/agent/tools.js';
import { PolicySchema } from '../src/policy/types.js';

const policy = PolicySchema.parse({
  version: 1,
  chainId: 84532,
  native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  tokens: {},
  recipients: {
    allowlist: { alice: '0x4785Dca37A242F3D80f844CB0b143A687008a2B5', bob: '0x1111111111111111111111111111111111111111' },
    denylist: ['0x000000000000000000000000000000000000dEaD'],
  },
  approvals: { allowUnlimited: false, spenderAllowlist: {} },
  rateLimit: { maxTxPerHour: 5 },
});

describe('resolveRecipient', () => {
  it('finds an allowlist label case-insensitively and returns its address', () => {
    const r = resolveRecipient(policy, 'Alice');
    expect(r).toMatchObject({ found: true, source: 'allowlist', allowlisted: true, address: '0x4785Dca37A242F3D80f844CB0b143A687008a2B5' });
  });

  it('recognises an allowlisted address given directly', () => {
    const r = resolveRecipient(policy, '0x4785dca37a242f3d80f844cb0b143a687008a2b5');
    expect(r).toMatchObject({ found: true, source: 'address', allowlisted: true, denylisted: false });
  });

  it('flags denylisted addresses and says not to send', () => {
    const r = resolveRecipient(policy, '0x000000000000000000000000000000000000dEaD');
    expect(r).toMatchObject({ found: true, denylisted: true, allowlisted: false });
    expect(r.guidance).toMatch(/denylist/i);
  });

  it('returns found=false with no address for unknown names, and lists known labels', () => {
    const r = resolveRecipient(policy, 'charlie');
    expect(r.found).toBe(false);
    expect(r.address).toBeUndefined();
    expect(r.knownLabels).toEqual(['alice', 'bob']);
    expect(r.guidance).toMatch(/ask the user for the 0x address/i);
  });

  it('treats a fresh address as a new recipient (T2), never as denied', () => {
    const r = resolveRecipient(policy, '0x2222222222222222222222222222222222222222');
    expect(r).toMatchObject({ found: true, source: 'address', allowlisted: false, denylisted: false });
    expect(r.guidance).toMatch(/T2/);
  });
});

describe('resolve_recipient tool wiring', () => {
  const ctx = {
    policy,
    clients: { publicClient: {}, account: undefined, chain: { id: 84532, name: 'Base Sepolia' } },
  } as unknown as ToolContext;

  it('is advertised to the model', () => {
    expect(toolDefinitions.some((t) => t.function.name === 'resolve_recipient')).toBe(true);
  });

  it('dispatches through runTool with validated arguments', async () => {
    const r = (await runTool('resolve_recipient', JSON.stringify({ name: 'alice' }), ctx)) as { found: boolean; address?: string };
    expect(r.found).toBe(true);
    expect(r.address).toBe('0x4785Dca37A242F3D80f844CB0b143A687008a2B5');
  });

  it('redispatches a missing name as an unknown recipient, not a crash', async () => {
    const r = (await runTool('resolve_recipient', '{}', ctx)) as { found: boolean; address?: string };
    expect(r.found).toBe(false);
    expect(r.address).toBeUndefined();
  });
});
