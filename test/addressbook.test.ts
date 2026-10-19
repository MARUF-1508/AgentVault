import { describe, expect, it } from 'vitest';
import { resolveRecipient } from '../src/agent/resolve.js';
import { addContact, addDenied, addRecipient, removeContact } from '../src/policy/edit.js';
import { evaluate } from '../src/policy/engine.js';
import { ALICE, BOB, basePolicy, CHAIN_ID } from './helpers.js';

const CAROL = '0x3333333333333333333333333333333333333333';

describe('address book (T2)', () => {
  const withBob = addContact(basePolicy(), 'bob', BOB);

  it('resolves a contact by name, case- and @-insensitively, and marks it as not allowlisted', () => {
    expect(resolveRecipient(withBob, '@Bob')).toMatchObject({ found: true, address: BOB, source: 'contacts', label: 'bob', allowlisted: false });
    expect(resolveRecipient(withBob, 'ALICE')).toMatchObject({ found: true, address: ALICE, source: 'allowlist' });
  });

  it('a contact is a name, not trust: sends to it still need a human (T2)', () => {
    const d = evaluate({ kind: 'native_transfer', to: BOB, amount: '0.0001' }, withBob, { spentToday: {}, txLastHour: 0, paused: false }, CHAIN_ID);
    expect(d.tier).toBe('T2_CONFIRM');
  });

  it('suggests near misses without ever resolving them', () => {
    const r = resolveRecipient(withBob, 'alcie');
    expect(r.found).toBe(false);
    expect(r.address).toBeUndefined();
    expect(r.didYouMean).toEqual(['alice']);
    expect(r.guidance).toMatch(/do NOT pick one yourself/);
    expect(resolveRecipient(withBob, 'zed').didYouMean).toBeUndefined();
  });

  it('labels an address that is saved as a contact', () => {
    expect(resolveRecipient(withBob, BOB)).toMatchObject({ source: 'address', label: 'bob', allowlisted: false });
  });

  it('refuses duplicate names, denied addresses and lookalikes; removal works', () => {
    expect(() => addContact(withBob, 'Bob', CAROL)).toThrow(/already/);
    expect(() => addContact(withBob, 'alice', CAROL)).toThrow(/already/);
    const denied = addDenied(basePolicy(), CAROL);
    expect(() => addContact(denied, 'carol', CAROL)).toThrow(/denylist/);
    const lookalike = `${ALICE.slice(0, 6)}${'0'.repeat(32)}${ALICE.slice(-4)}`;
    expect(() => addContact(basePolicy(), 'mallory', lookalike)).toThrow(/poisoning/);
    expect(removeContact(withBob, 'bob').recipients.contacts).toEqual({});
    expect(() => removeContact(withBob, 'nobody')).toThrow();
  });

  it('allowlist and deny edits keep the address book, and denying an address drops its contact', () => {
    const more = addRecipient(withBob, 'carol', CAROL);
    expect(more.recipients.contacts).toEqual({ bob: BOB });
    expect(addDenied(withBob, BOB).recipients.contacts).toEqual({});
  });
});
