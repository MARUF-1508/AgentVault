import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { can, ROLES } from '../src/auth/rbac.js';
import { LoginThrottle, Sessions, UserStore } from '../src/auth/users.js';

describe('rbac', () => {
  it('only an owner may approve or pause; a viewer may only read', () => {
    expect(ROLES.filter((r) => can(r, 'approve'))).toEqual(['owner']);
    expect(ROLES.filter((r) => can(r, 'pause'))).toEqual(['owner']);
    expect(ROLES.filter((r) => can(r, 'transact'))).toEqual(['operator', 'owner']);
    expect(ROLES.every((r) => can(r, 'read'))).toBe(true);
    expect(can('viewer', 'chat')).toBe(false);
  });
});

describe('UserStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-store-'));
  const file = join(dir, 'users.json');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('stores a salted scrypt hash, never the password, and verifies it', () => {
    const store = new UserStore(file);
    const pw = store.add('alice', 'owner');
    expect(readFileSync(file, 'utf8')).not.toContain(pw);
    expect(store.verify('alice', pw)).toEqual({ username: 'alice', role: 'owner' });
    expect(store.verify('alice', `${pw}x`)).toBeNull();
    expect(store.verify('nobody', pw)).toBeNull();
  });

  it('rejects short passwords and malformed names, and removes users', () => {
    const store = new UserStore(file);
    expect(() => store.add('bob', 'viewer', 'short')).toThrow();
    expect(() => store.add('Bad Name', 'viewer')).toThrow();
    store.add('bob', 'viewer');
    expect(store.remove('bob')).toBe(true);
    expect(store.list().map((u) => u.username)).toEqual(['alice']);
  });
});

describe('Sessions and LoginThrottle', () => {
  it('expires sessions and forgets destroyed tokens', () => {
    const expired = new Sessions(-1);
    expect(expired.get(expired.create({ username: 'a', role: 'viewer' }).token)).toBeNull();
    const live = new Sessions();
    const { token } = live.create({ username: 'a', role: 'viewer' });
    expect(live.get(token)).toEqual({ username: 'a', role: 'viewer' });
    live.destroy(token);
    expect(live.get(token)).toBeNull();
  });

  it('blocks after max failures inside the window, then recovers', () => {
    const t = new LoginThrottle(2, 1000);
    t.fail('a', 0);
    t.fail('a', 10);
    expect(t.blocked('a', 20)).toBe(true);
    expect(t.blocked('a', 2000)).toBe(false);
  });
});
