import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolDefinitions } from '../src/agent/tools.js';
import { addDenied, addRecipient, applyPolicy, removeDenied, removeRecipient, writePolicyAtomic } from '../src/policy/edit.js';
import { evaluate } from '../src/policy/engine.js';
import { PolicySchema, type Policy, type SpendState } from '../src/policy/types.js';

const ALICE = '0x4785Dca37A242F3D80f844CB0b143A687008a2B5';
const STRANGER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

const fresh = (): SpendState => ({ spentToday: {}, txLastHour: 0, paused: false });

const base = (): Policy =>
  PolicySchema.parse({
    version: 1,
    chainId: 84532,
    native: { symbol: 'ETH', autoMaxPerTx: '0.001', hardMaxPerTx: '0.005', dailyBudget: '0.01' },
    tokens: {},
    recipients: { allowlist: { alice: ALICE }, denylist: [] },
    approvals: { allowUnlimited: false, spenderAllowlist: {} },
    rateLimit: { maxTxPerHour: 10 },
  });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('recipient edits', () => {
  it('adds a known recipient and keeps the policy loadable', () => {
    const next = addRecipient(base(), 'bob', STRANGER);
    expect(next.recipients.allowlist).toEqual({ alice: ALICE, bob: STRANGER });
    expect(() => PolicySchema.parse(next)).not.toThrow();
    // The original is untouched: every edit is a new object.
    expect(base().recipients.allowlist).toEqual({ alice: ALICE });
  });

  it('checksums the address it stores, whatever case it was given in', () => {
    const next = addRecipient(base(), 'bob', STRANGER.toUpperCase().replace('0X', '0x'));
    expect(next.recipients.allowlist.bob).toBe(STRANGER);
  });

  it('rejects a duplicate label or an address already allowlisted', () => {
    expect(() => addRecipient(base(), 'Alice', OTHER)).toThrow(/already a recipient/i);
    expect(() => addRecipient(base(), 'again', ALICE.toLowerCase())).toThrow(/already in the allowlist/i);
  });

  it('refuses to allowlist an address that is on the denylist', () => {
    const denied = addDenied(base(), OTHER);
    expect(() => addRecipient(denied, 'bob', OTHER)).toThrow(/denylist/i);
  });

  it('refuses an address that imitates an allowlisted one (address poisoning)', () => {
    // Same first 4 and last 4 hex characters as alice, different middle.
    const lookalike = `0x4785${'0'.repeat(32)}a2b5`;
    expect(() => addRecipient(base(), 'evil', lookalike)).toThrow(/poisoning/i);
  });

  it('removes a recipient so sends to it fall back to T2', () => {
    const withBob = addRecipient(base(), 'bob', OTHER);
    const intent = { kind: 'native_transfer', to: OTHER, amount: '0.0002' } as const;
    expect(evaluate(intent, withBob, fresh(), 84532).tier).toBe('T1_AUTO');
    const after = removeRecipient(withBob, 'bob');
    expect(evaluate(intent, after, fresh(), 84532).tier).toBe('T2_CONFIRM');
  });

  it('denying an address wins over having it allowlisted', () => {
    const denied = addDenied(base(), ALICE);
    expect(denied.recipients.denylist).toEqual([ALICE]);
    // addDenied also drops the now-misleading allowlist entry.
    expect(denied.recipients.allowlist).toEqual({});
    const intent = { kind: 'native_transfer', to: ALICE, amount: '0.0002' } as const;
    expect(evaluate(intent, denied, fresh(), 84532).tier).toBe('T3_DENY');
  });

  it('un-denying restores the ordinary T2 path', () => {
    const denied = addDenied(base(), ALICE);
    const back = removeDenied(denied, ALICE);
    expect(back.recipients.denylist).toEqual([]);
    const intent = { kind: 'native_transfer', to: ALICE, amount: '0.0002' } as const;
    expect(evaluate(intent, back, fresh(), 84532).tier).toBe('T2_CONFIRM');
  });

  it('reports unknown labels and addresses instead of silently doing nothing', () => {
    expect(() => removeRecipient(base(), 'nobody')).toThrow(/No recipient/i);
    expect(() => removeDenied(base(), OTHER)).toThrow(/not on the denylist/i);
    expect(() => addDenied(addDenied(base(), OTHER), OTHER)).toThrow(/already on the denylist/i);
    expect(() => addRecipient(base(), 'bob', 'not-an-address')).toThrow();
  });
});

describe('writing and applying', () => {
  it('writes a file the engine can load, with no temp file left behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'av-policy-'));
    dirs.push(dir);
    const path = join(dir, 'policy.json');
    writePolicyAtomic(path, base());
    const reloaded = PolicySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(reloaded.recipients.allowlist.alice).toBe(ALICE);
    expect(() => readFileSync(`${path}.tmp`)).toThrow();
  });

  it('applyPolicy swaps the live object the executor holds a reference to', () => {
    const live = base();
    const next = addRecipient(live, 'bob', OTHER);
    applyPolicy(live, next);
    expect(live.recipients.allowlist).toEqual({ alice: ALICE, bob: OTHER });
  });

  it('leaves the engine pure: the same policy object always decides the same way', () => {
    const policy = base();
    const intent = { kind: 'native_transfer', to: OTHER, amount: '0.0002' } as const;
    const state = fresh();
    expect(evaluate(intent, policy, state, 84532)).toEqual(evaluate(intent, policy, state, 84532));
  });
});

describe('the LLM cannot reach the recipient lists', () => {
  it('exposes no tool that mutates an allowlist or denylist entry', () => {
    // AGENTS.md: never give the LLM a tool that changes the allowlists. Reading
    // them (get_policy, resolve_recipient) is fine and intentional; changing them
    // is not, so the lists are editable only over owner-only routes or the CLI.
    const names = toolDefinitions.map((t) => t.function.name);
    for (const forbidden of ['add_recipient', 'remove_recipient', 'set_allowlist', 'set_denylist', 'edit_policy']) {
      expect(names).not.toContain(forbidden);
    }
    const words = JSON.stringify(toolDefinitions).toLowerCase();
    // Read-only tools may mention the lists...
    expect(words).toMatch(/allowlist/);
    // ...but none may offer to edit, add or remove them.
    expect(words).not.toMatch(/(add|edit|change|update|remove|set)[a-z ]{0,12}(allowlist|denylist)/);
  });
});
