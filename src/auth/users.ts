import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ROLES, type Role } from './rbac.js';

const UserRecord = z.object({
  username: z.string().regex(/^[a-z0-9_-]{2,32}$/),
  role: z.enum(ROLES),
  salt: z.string().regex(/^[0-9a-f]{32}$/),
  hash: z.string().regex(/^[0-9a-f]{128}$/),
  /** Base32 TOTP secret, present once the user has confirmed 2FA setup. */
  totp: z.string().regex(/^[A-Z2-7]{16,64}$/).optional(),
});

const UsersFile = z.object({ version: z.literal(1), users: z.array(UserRecord) });

export interface User {
  username: string;
  role: Role;
}

const hashPassword = (password: string, salt: string) => scryptSync(password, salt, 64).toString('hex');

/**
 * Local web-UI accounts in a git-ignored JSON file. Passwords are stored as
 * scrypt hashes with a per-user salt and compared in constant time. Accounts
 * are managed from the CLI only (`user add|list|remove`); neither the web UI
 * nor the LLM can create or change them.
 */
export class UserStore {
  constructor(private readonly path: string) {}

  private load(): z.infer<typeof UsersFile> {
    if (!existsSync(this.path)) return { version: 1, users: [] };
    return UsersFile.parse(JSON.parse(readFileSync(this.path, 'utf8')));
  }

  private save(data: z.infer<typeof UsersFile>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  list(): User[] {
    return this.load().users.map(({ username, role }) => ({ username, role }));
  }

  /** Adds or replaces a user. Returns the password (generated when omitted). */
  add(username: string, role: Role, password = randomBytes(12).toString('base64url')): string {
    if (password.length < 10) throw new Error('Password must be at least 10 characters.');
    const salt = randomBytes(16).toString('hex');
    const record = UserRecord.parse({ username, role, salt, hash: hashPassword(password, salt) });
    const data = this.load();
    data.users = [...data.users.filter((u) => u.username !== username), record];
    this.save(data);
    return password;
  }

  /** The user's confirmed TOTP secret, or null when 2FA is off. */
  totpSecret(username: string): string | null {
    return this.load().users.find((u) => u.username === username)?.totp ?? null;
  }

  /** Enables (secret) or disables (null) 2FA for a user. Audit this at the call site. */
  setTotp(username: string, secret: string | null): void {
    const data = this.load();
    data.users = data.users.map((u) => {
      if (u.username !== username) return u;
      const { totp: _drop, ...rest } = u;
      return secret === null ? rest : { ...rest, totp: UserRecord.parse({ ...rest, totp: secret }).totp! };
    });
    this.save(data);
  }

  remove(username: string): boolean {
    const data = this.load();
    const before = data.users.length;
    data.users = data.users.filter((u) => u.username !== username);
    if (data.users.length === before) return false;
    this.save(data);
    return true;
  }

  /** The user when the password matches, else null. Constant-time compare. */
  verify(username: string, password: string): User | null {
    const record = this.load().users.find((u) => u.username === username);
    // Hash even for unknown users so timing does not reveal which names exist.
    const salt = record?.salt ?? '0'.repeat(32);
    const actual = Buffer.from(hashPassword(password, salt), 'hex');
    const expected = Buffer.from(record?.hash ?? '0'.repeat(128), 'hex');
    if (!timingSafeEqual(actual, expected) || !record) return null;
    return { username: record.username, role: record.role };
  }
}

/** In-memory sessions keyed by an unguessable token; lost on restart by design. */
export class Sessions {
  private readonly byToken = new Map<string, User & { expires: number; lastSeen: number }>();

  /**
   * `ttlMs` is the absolute lifetime; `idleMs` signs a session out after that
   * much inactivity even if the absolute lifetime has not passed.
   */
  constructor(
    private readonly ttlMs = 8 * 60 * 60 * 1000,
    private readonly idleMs = 30 * 60 * 1000,
  ) {}

  create(user: User, now = Date.now()): { token: string; maxAgeSec: number } {
    const token = randomBytes(32).toString('base64url');
    this.byToken.set(token, { ...user, expires: now + this.ttlMs, lastSeen: now });
    return { token, maxAgeSec: Math.floor(this.ttlMs / 1000) };
  }

  get(token: string | undefined, now = Date.now()): User | null {
    if (!token) return null;
    const s = this.byToken.get(token);
    if (!s) return null;
    if (s.expires < now || now - s.lastSeen > this.idleMs) {
      this.byToken.delete(token);
      return null;
    }
    s.lastSeen = now;
    return { username: s.username, role: s.role };
  }

  destroy(token: string | undefined): void {
    if (token) this.byToken.delete(token);
  }

  /** Drops every session a user has, e.g. right after their account is removed. */
  destroyUser(username: string): void {
    for (const [token, s] of this.byToken) if (s.username === username) this.byToken.delete(token);
  }

  /** Drops every session of a user except `keepToken`; returns how many were ended. */
  destroyUserExcept(username: string, keepToken: string | undefined): number {
    let n = 0;
    for (const [token, s] of this.byToken) {
      if (s.username === username && token !== keepToken) {
        this.byToken.delete(token);
        n++;
      }
    }
    return n;
  }
}

/** Per-username failed-login throttle: after `max` failures in `windowMs`, refuse. */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  blocked(username: string, now = Date.now()): boolean {
    const recent = (this.failures.get(username) ?? []).filter((t) => now - t < this.windowMs);
    this.failures.set(username, recent);
    return recent.length >= this.max;
  }

  fail(username: string, now = Date.now()): void {
    this.failures.set(username, [...(this.failures.get(username) ?? []), now]);
  }

  clear(username: string): void {
    this.failures.delete(username);
  }
}
