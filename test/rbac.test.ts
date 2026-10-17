import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { can, ROLES } from '../src/auth/rbac.js';
import { LoginThrottle, Sessions, UserStore } from '../src/auth/users.js';

describe('rbac', () => {
  it('only an owner may approve, pause or manage accounts; a viewer may only read', () => {
    expect(ROLES.filter((r) => can(r, 'approve'))).toEqual(['owner']);
    expect(ROLES.filter((r) => can(r, 'pause'))).toEqual(['owner']);
    expect(ROLES.filter((r) => can(r, 'admin'))).toEqual(['owner']);
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

  it('destroyUser drops every session of one user and leaves others alone', () => {
    const s = new Sessions();
    const a1 = s.create({ username: 'a', role: 'owner' }).token;
    const a2 = s.create({ username: 'a', role: 'owner' }).token;
    const b = s.create({ username: 'b', role: 'viewer' }).token;
    s.destroyUser('a');
    expect(s.get(a1)).toBeNull();
    expect(s.get(a2)).toBeNull();
    expect(s.get(b)).toEqual({ username: 'b', role: 'viewer' });
  });

  it('signs a session out after idleMs of inactivity, before the absolute TTL', () => {
    // 60s absolute TTL, 1s idle timeout.
    const s = new Sessions(60_000, 1_000);
    const { token } = s.create({ username: 'a', role: 'viewer' }, 0);
    expect(s.get(token, 900)).not.toBeNull();
    // 1.5s after the last seen request (not the last 1s of absolute life).
    expect(s.get(token, 2400)).toBeNull();
    // The absolute TTL still applies even with a long idle window.
    const longIdle = new Sessions(1_000, 60_000);
    const t2 = longIdle.create({ username: 'b', role: 'viewer' }, 0).token;
    expect(longIdle.get(t2, 500)).not.toBeNull();
    expect(longIdle.get(t2, 1_500)).toBeNull();
  });

  it('destroyUserExcept ends other sessions but keeps the current one', () => {
    const s = new Sessions();
    const mine = s.create({ username: 'a', role: 'owner' }).token;
    const phone = s.create({ username: 'a', role: 'owner' }).token;
    const other = s.create({ username: 'b', role: 'viewer' }).token;
    expect(s.destroyUserExcept('a', mine)).toBe(1);
    expect(s.get(mine)).toEqual({ username: 'a', role: 'owner' });
    expect(s.get(phone)).toBeNull();
    expect(s.get(other)).toEqual({ username: 'b', role: 'viewer' });
  });

  it('blocks after max failures inside the window, then recovers', () => {
    const t = new LoginThrottle(2, 1000);
    t.fail('a', 0);
    t.fail('a', 10);
    expect(t.blocked('a', 20)).toBe(true);
    expect(t.blocked('a', 2000)).toBe(false);
  });
});
