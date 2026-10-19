import { renameSync, writeFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { z } from 'zod';
import { assessAddress } from '../risk/address.js';
import { Address as AddressSchema, PolicySchema, type Policy } from './types.js';

/** Labels land in the audit log and the UI, so keep them short and printable. */
const Label = z.string().trim().min(1).max(40).regex(/^[\w .@-]+$/, 'letters, digits, space and . _ - @ only');

const same = (a: string, b: string) => getAddress(a) === getAddress(b);

/**
 * Recipient-list edits. Every function is pure: it takes a policy and returns a
 * brand-new one that has been through `PolicySchema` again, so an edit can never
 * leave the wallet holding a policy the engine could not load. Nothing here
 * touches the audit log — the caller logs the change — which keeps this module
 * trivial to test.
 *
 * Adding to the allowlist, or removing from the denylist, *lowers* the tier a
 * recipient gets, which is why those are the two guarded directions in the UI.
 */

/** Adds a known recipient. Escalating: a known recipient can receive automatic T1 transfers. */
export function addRecipient(policy: Policy, labelRaw: string, addressRaw: string): Policy {
  const label = Label.parse(labelRaw);
  const address = AddressSchema.parse(addressRaw);
  const { allowlist, denylist } = policy.recipients;

  if (Object.keys(allowlist).some((k) => k.toLowerCase() === label.toLowerCase())) {
    throw new Error(`There is already a recipient called "${label}".`);
  }
  if (denylist.some((a) => same(a, address))) {
    throw new Error(`${address} is on the denylist. Remove it there first.`);
  }
  if (Object.values(allowlist).some((a) => same(a, address))) {
    throw new Error(`${address} is already in the allowlist.`);
  }
  const { lookalikeOf } = assessAddress(address, policy);
  if (lookalikeOf) {
    throw new Error(`${address} closely resembles the allowlisted ${lookalikeOf} (possible address poisoning). Refused.`);
  }
  return PolicySchema.parse({ ...policy, recipients: { ...policy.recipients, allowlist: { ...allowlist, [label]: address }, denylist } });
}

/** Drops a known recipient. Fail-safe: sends to it fall back to T2, never automatic. */
export function removeRecipient(policy: Policy, labelRaw: string): Policy {
  const label = labelRaw.trim();
  if (!(label in policy.recipients.allowlist)) throw new Error(`No recipient called "${label}".`);
  const allowlist = { ...policy.recipients.allowlist };
  delete allowlist[label];
  return PolicySchema.parse({ ...policy, recipients: { ...policy.recipients, allowlist } });
}

/**
 * Refuses an address outright. Fail-safe. The engine checks the denylist before
 * the allowlist, so a denied address stays refused even if it is also listed as
 * a known recipient; the allowlist entry is dropped anyway so the two lists stay
 * honest for the human reading them.
 */
export function addDenied(policy: Policy, addressRaw: string): Policy {
  const address = AddressSchema.parse(addressRaw);
  const { allowlist, denylist } = policy.recipients;
  if (denylist.some((a) => same(a, address))) throw new Error(`${address} is already on the denylist.`);
  const next = { ...allowlist };
  for (const [label, a] of Object.entries(next)) if (same(a, address)) delete next[label];
  const contacts = { ...policy.recipients.contacts };
  for (const [label, a] of Object.entries(contacts)) if (same(a, address)) delete contacts[label];
  return PolicySchema.parse({ ...policy, recipients: { ...policy.recipients, allowlist: next, contacts, denylist: [...denylist, address] } });
}

/** Un-refuses an address. Escalating: it stops being T3 and becomes T2 or T1 again. */
export function removeDenied(policy: Policy, addressRaw: string): Policy {
  const address = AddressSchema.parse(addressRaw);
  const denylist = policy.recipients.denylist;
  const index = denylist.findIndex((a) => same(a, address));
  if (index === -1) throw new Error(`${address} is not on the denylist.`);
  const next = [...denylist.slice(0, index), ...denylist.slice(index + 1)];
  return PolicySchema.parse({ ...policy, recipients: { ...policy.recipients, denylist: next } });
}

/**
 * Adds an address-book contact (T2). Not escalating: a contact only gets a name,
 * its transfers still need a human approval. Denied and lookalike addresses are
 * refused so the book cannot be used to smuggle in a poisoned address.
 */
export function addContact(policy: Policy, labelRaw: string, addressRaw: string): Policy {
  const label = Label.parse(labelRaw);
  const address = AddressSchema.parse(addressRaw);
  const { contacts, allowlist, denylist } = policy.recipients;
  const taken = [...Object.keys(contacts), ...Object.keys(allowlist)].some((k) => k.toLowerCase() === label.toLowerCase());
  if (taken) throw new Error(`There is already a recipient or contact called "${label}".`);
  if (denylist.some((a) => same(a, address))) throw new Error(`${address} is on the denylist.`);
  const { lookalikeOf } = assessAddress(address, policy);
  if (lookalikeOf) {
    throw new Error(`${address} closely resembles the allowlisted ${lookalikeOf} (possible address poisoning). Refused.`);
  }
  return PolicySchema.parse({ ...policy, recipients: { ...policy.recipients, contacts: { ...contacts, [label]: address } } });
}

export function removeContact(policy: Policy, labelRaw: string): Policy {
  const label = labelRaw.trim();
  if (!(label in policy.recipients.contacts)) throw new Error(`No contact called "${label}".`);
  const contacts = { ...policy.recipients.contacts };
  delete contacts[label];
  return PolicySchema.parse({ ...policy, recipients: { ...policy.recipients, contacts } });
}

/**
 * Writes the policy file atomically: a temp file in the same directory, then a
 * rename. A crash mid-write therefore leaves the old, complete policy in place
 * instead of a truncated file that would fail to parse at the next start. The
 * serialised text is parsed once more first, so we never write a file the engine
 * could not load.
 */
export function writePolicyAtomic(path: string, policy: Policy): void {
  const json = `${JSON.stringify(policy, null, 2)}\n`;
  PolicySchema.parse(JSON.parse(json));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, json);
  renameSync(tmp, path);
}

/**
 * Applies an edited policy to the live object the executor and the tools already
 * hold. `Executor` keeps the policy by reference and reads it per decision, so
 * replacing the top-level keys is enough for the change to take effect at once.
 * `evaluate` stays pure either way: it is handed the object as an argument.
 */
export function applyPolicy(live: Policy, next: Policy): void {
  for (const key of Object.keys(live)) delete (live as Record<string, unknown>)[key];
  Object.assign(live, next);
}