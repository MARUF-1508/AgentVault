import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Policy file integrity (S4). The policy is the security boundary, so the file
 * it is loaded from is fingerprinted: `POLICY_SHA256` pins the expected hash
 * (start-up refuses a mismatch), and a running server reports drift when the
 * file on disk no longer matches what it loaded or last wrote itself.
 */
export function policyFileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** True when `pinned` (full hash, or a prefix of at least 16 hex chars) matches. */
export function matchesPin(hash: string, pinned: string): boolean {
  const p = pinned.trim().toLowerCase();
  return /^[0-9a-f]{16,64}$/.test(p) && hash.startsWith(p);
}

/** Throws when a pin is set and the file does not match it. */
export function assertPinnedPolicy(path: string, pinned: string | undefined): string {
  const hash = policyFileHash(path);
  if (pinned && !matchesPin(hash, pinned)) {
    throw new Error(
      `Policy file ${path} has sha256 ${hash.slice(0, 16)}…, but POLICY_SHA256 pins ${pinned.slice(0, 16)}…. ` +
        'Refusing to start: the policy may have been tampered with. Check the file, then update the pin.',
    );
  }
  return hash;
}

/** Tracks the hash the process trusts, for drift reporting. */
export class PolicyIntegrity {
  private expected: string | null;

  constructor(private readonly path: string, private readonly pinned?: string) {
    this.expected = safeHash(path);
  }

  /** Call after this process writes the policy itself (an audited edit). */
  accept(): void {
    this.expected = safeHash(this.path);
  }

  status(): { hash: string | null; expected: string | null; drift: boolean; pinned: boolean; matchesPin: boolean | null } {
    const hash = safeHash(this.path);
    return {
      hash,
      expected: this.expected,
      drift: hash !== this.expected,
      pinned: Boolean(this.pinned),
      matchesPin: this.pinned && hash ? matchesPin(hash, this.pinned) : null,
    };
  }
}

function safeHash(path: string): string | null {
  try {
    return policyFileHash(path);
  } catch {
    return null;
  }
}
