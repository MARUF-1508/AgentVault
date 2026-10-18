import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../src/web/server.js';

/**
 * `ROUTES` is the only thing that turns a `/api/...` handler into an
 * authenticated one: the request gate is `if (path.startsWith('/api/') && needs)`
 * where `needs = ROUTES[method + ' ' + path]`. A handler whose path is missing
 * from the map therefore runs with no session and no role check. This test fails
 * the moment someone adds a route and forgets the map entry, which is exactly the
 * class of bug the audit found in this server.
 */

/**
 * Reachable before sign-in, or enforcing the session itself: login/logout/setup
 * and the self-service 2FA and session routes. Everything here is checked by hand
 * (e.g. `if (!user) return 401`) rather than through ROUTES.
 */
const PRE_AUTH = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/setup',
  '/api/auth/me',
  '/api/auth/totp',
  '/api/auth/totp/setup',
  '/api/auth/totp/enable',
  '/api/auth/totp/disable',
  '/api/auth/sessions/revoke',
]);

const source = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf8');

/** Every `/api/...` path the server compares `path` against, exactly or by prefix. */
function apiRoutesInSource(): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(/path\s*===\s*['"](\/api\/[A-Za-z0-9/_-]*)['"]/g)) found.add(m[1]!);
  for (const m of source.matchAll(/path\.startsWith\(['"](\/api\/[A-Za-z0-9/_-]*)['"]\)/g)) found.add(m[1]!);
  // The auth gate itself compares against `path.startsWith('/api/')`; not a route.
  found.delete('/api/');
  return found;
}

/** A path ending in `/` in the source is a prefix match (a whole route family). */
function isCovered(path: string): boolean {
  if (PRE_AUTH.has(path)) return true;
  const prefix = path.endsWith('/');
  return Object.keys(ROUTES).some((key) => {
    const target = key.slice(key.indexOf(' ') + 1);
    return prefix ? target.startsWith(path) : target === path;
  });
}

describe('API route coverage', () => {
  it('every /api path the server handles is either pre-auth or in the permission map', () => {
    const uncovered = [...apiRoutesInSource()].filter((path) => !isCovered(path));
    expect(uncovered).toEqual([]);
  });

  it('every permission-map entry names a path the server actually handles', () => {
    const handled = [...apiRoutesInSource()];
    const orphans = Object.keys(ROUTES).filter((key) => {
      const target = key.slice(key.indexOf(' ') + 1);
      return !handled.some((path) => (path.endsWith('/') ? target.startsWith(path) : target === path));
    });
    expect(orphans).toEqual([]);
  });

  it('protects every state-changing route behind a permission, not just a session', () => {
    // A route that only had `read` would let a viewer mutate state; these are the
    // mutations, and each must need more than reading.
    for (const key of ['POST /api/transact', 'POST /api/decide', 'POST /api/pause', 'POST /api/users', 'POST /api/users/remove']) {
      expect(ROUTES[key]).toBeDefined();
      expect(ROUTES[key]).not.toBe('read');
    }
  });
});
