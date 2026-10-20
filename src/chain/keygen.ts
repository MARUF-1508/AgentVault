import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export interface KeygenResult {
  /** The public address of the key that is now in the env file. */
  address: `0x${string}`;
  /** The address that was there before, if any. */
  previous: `0x${string}` | null;
  /** False when a key already existed and `force` was not set. */
  replaced: boolean;
}

const KEY_LINE = /^AGENT_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m;

/**
 * Creates a fresh testnet key and stores it in an env file (never returned).
 * The file is written atomically enough for this purpose by replacing or
 * appending one line; permissions are tightened to 600. Returns only public
 * information so callers can show the address.
 */
export function writeAgentKey(
  path: string,
  opts: { force?: boolean; fallbackPath?: string } = {},
): KeygenResult {
  let env = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (!env && opts.fallbackPath && existsSync(opts.fallbackPath)) env = readFileSync(opts.fallbackPath, 'utf8');
  const existing = env.match(KEY_LINE)?.[1] as `0x${string}` | undefined;
  if (existing && !opts.force) {
    return { address: privateKeyToAccount(existing).address, previous: privateKeyToAccount(existing).address, replaced: false };
  }
  const key = generatePrivateKey();
  env = KEY_LINE.test(env)
    ? env.replace(KEY_LINE, `AGENT_PRIVATE_KEY=${key}`)
    : `${env}${env && !env.endsWith('\n') ? '\n' : ''}AGENT_PRIVATE_KEY=${key}\n`;
  writeFileSync(path, env);
  chmodSync(path, 0o600);
  return {
    address: privateKeyToAccount(key).address,
    previous: existing ? privateKeyToAccount(existing).address : null,
    replaced: true,
  };
}
