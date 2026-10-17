export interface Holding {
  asset: string;
  kind: string;
  balance: string;
  usdPrice?: string;
  usdValue?: string;
  priceSource?: string;
}

export interface Portfolio {
  address: string | null;
  chain: string;
  chainId: number;
  holdings: Holding[];
  totalUsd: string;
}

export interface Policy {
  native: { symbol: string; autoMaxPerTx: string; hardMaxPerTx: string; dailyBudget: string };
  tokens: Record<string, { autoMaxPerTx: string; hardMaxPerTx: string; dailyBudget: string }>;
  recipients: { allowlist: Record<string, string>; denylist: string[] };
  rateLimit: { maxTxPerHour: number };
}

export interface Status {
  address: string | null;
  chain: string;
  chainId: number;
  explorer: string | null;
  paused: boolean;
  vault: string | null;
  llm: boolean;
  model: string | null;
}

export interface BudgetAsset {
  asset: string;
  spentToday: string;
  dailyBudget: string;
  autoMaxPerTx: string;
  hardMaxPerTx: string;
}

export interface Budget {
  paused: boolean;
  txLastHour: number;
  maxTxPerHour: number;
  assets: BudgetAsset[];
}

export interface ActivityEntry {
  seq: number;
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

export interface DailyStat {
  date: string;
  txCount: number;
  deniedCount: number;
  spentBase: Record<string, string>;
}

export type Role = 'viewer' | 'operator' | 'owner';
export type Permission = 'read' | 'preview' | 'transact' | 'chat' | 'approve' | 'pause' | 'admin';

export interface UserAccount {
  username: string;
  role: Role;
}

export interface NewAccount {
  username: string;
  role: Role;
  /** Shown exactly once, when the account is created. */
  password: string;
}

export interface Me {
  user: string;
  role: Role;
  permissions: Permission[];
}

export type Tier = 'T1_AUTO' | 'T2_CONFIRM' | 'T3_DENY';

export type TransferIntent =
  | { kind: 'native_transfer'; to: string; amount: string }
  | { kind: 'erc20_transfer'; token: string; to: string; amount: string };

export interface TransactResult {
  status: string;
  tier: Tier;
  reasons: string[];
  txHash?: string;
  explorerUrl?: string;
  error?: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, credentials: 'same-origin', ...init });
  // A lapsed session anywhere sends the app back to the sign-in page.
  if (r.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('av:unauthorized'));
  const data = (await r.json()) as T & { error?: string; issues?: string[] };
  if (!r.ok) throw new Error([data.error ?? `HTTP ${r.status}`, ...(data.issues ?? [])].join(': '));
  return data;
}

/** Read tools report failures as `{ error }` with HTTP 200 (e.g. an RPC outage); surface them as errors. */
async function read<T>(path: string): Promise<T> {
  const data = await api<T | { error: string }>(path);
  if (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as { error?: unknown }).error === 'string') {
    throw new Error((data as { error: string }).error);
  }
  return data as T;
}

const post = <T>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const getMe = () => api<Me>('/api/auth/me');
/** Public: true when the store has no accounts yet (first-run setup screen). */
export const getSetupNeeded = () => api<{ needed: boolean }>('/api/auth/setup');
export const setup = (username: string, password: string) => post<Me>('/api/auth/setup', { username, password });
export const login = (username: string, password: string) => post<Me>('/api/auth/login', { username, password });
export const logout = () => post<{ ok: boolean }>('/api/auth/logout', {});
export const getUsers = () => read<{ users: UserAccount[]; you: string }>('/api/users');
export const addUser = (username: string, role: Role) => post<NewAccount>('/api/users', { username, role });
export const removeUser = (username: string) => post<{ removed: boolean }>('/api/users/remove', { username });
export const getStatus = () => read<Status>('/api/status');
export const getPortfolio = () => read<Portfolio>('/api/portfolio');
export const getPolicy = () => read<Policy>('/api/policy');
export const getBudget = () => read<Budget>('/api/budget');
export const getActivity = (limit = 30) => read<ActivityEntry[]>(`/api/activity?limit=${limit}`);
export const getStats = () => read<DailyStat[]>('/api/stats');
export const getVerify = () => read<{ ok: boolean; brokenAt?: number; reason?: string }>('/api/verify');
export const getPending = () => read<{ pending: string | null; expiresAt: number | null }>('/api/pending');
export const decide = (approved: boolean) => post<{ decided: boolean }>('/api/decide', { approved });
export const pause = () => post<{ paused: boolean }>('/api/pause', {});
export const preview = (intent: TransferIntent) => post<{ tier: Tier; reasons: string[] }>('/api/preview', { intent });
export const transact = (intent: TransferIntent) => post<TransactResult>('/api/transact', { intent });
export const chat = (message: string, session?: string) =>
  post<{ session: string; answer: string; events?: string[] }>('/api/chat', { message, session });
