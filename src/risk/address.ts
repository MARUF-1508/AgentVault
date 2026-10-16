import { getAddress, type Address, type PublicClient } from 'viem';
import type { AddressRisk, Policy } from '../policy/types.js';

/**
 * Address-risk checks. The pure part (block list, lookalike detection) is
 * separated from the chain read (does the address have code?) so the policy
 * engine can stay a pure function: the executor calls `checkAddress` and passes
 * the findings into `evaluate` as `SpendState.risk`.
 */

/** Pure: block-list membership and lookalike (address-poisoning) detection. */
export function assessAddress(address: Address, policy: Policy): Omit<AddressRisk, 'isContract'> {
  const target = getAddress(address);
  const risk = policy.risk;

  const onBlocklist = (risk?.blocklist ?? []).some((a) => getAddress(a) === target);

  const look = risk?.lookalike;
  let lookalikeOf: `0x${string}` | undefined;
  if (look?.enabled ?? true) {
    const prefix = look?.prefix ?? 4;
    const suffix = look?.suffix ?? 4;
    const t = target.slice(2).toLowerCase();
    for (const allowed of Object.values(policy.recipients.allowlist)) {
      const a = getAddress(allowed);
      if (a === target) continue;
      const h = a.slice(2).toLowerCase();
      if (prefix > 0 && h.slice(0, prefix) !== t.slice(0, prefix)) continue;
      if (suffix > 0 && h.slice(-suffix) !== t.slice(-suffix)) continue;
      lookalikeOf = a;
      break;
    }
  }

  return lookalikeOf ? { onBlocklist, lookalikeOf } : { onBlocklist };
}

/**
 * Chain-aware check: adds whether the address has bytecode. If the RPC cannot
 * answer we treat the address as a contract (fail closed), so the engine raises
 * the tier instead of silently trusting an unknown address.
 */
export async function checkAddress(
  publicClient: PublicClient,
  policy: Policy,
  address: Address,
): Promise<AddressRisk> {
  const base = assessAddress(address, policy);
  let isContract = true;
  try {
    const code = await publicClient.getCode({ address: getAddress(address) });
    isContract = code !== undefined && code !== '0x';
  } catch {
    isContract = true;
  }
  return { ...base, isContract };
}
