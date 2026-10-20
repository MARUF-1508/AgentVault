export interface Holding {
  asset: string;
  kind: string;
  balance: string;
  usdPrice?: string;
  usdValue?: string;
  priceSource?: string;
  /** Set when this balance could not be read; the other holdings still load. */
  error?: string;
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
  recipients: { allowlist: Record<string, string>; denylist: string[]; contacts?: Record<string, string> };
  rateLimit: { maxTxPerHour: number; velocity?: { windowMinutes: number; maxTx: number; maxSpendPct: number } };
  swap?: {
    router: string;
    quoter: string;
    feeTier: number;
    autoMaxSlippageBps: number;
    maxSlippageBps: number;
    tokens?: string[];
  };
}

export interface Health {
  ok: boolean;
  status: 'ok' | 'degraded';
  chain: string;
  chainId: number;
  rpc: { ok: boolean; blockNumber?: string; latencyMs?: number; error?: string };
  auditIntact: boolean;
  uptimeSec: number;
}

export interface TxStatus {
  hash: string;
  status: 'pending' | 'confirmed' | 'reverted' | 'unknown';
  blockNumber?: string;
  confirmations?: number;
  explorerUrl?: string;
}

/** The engine's compliant alternative to a refused or approval-bound transfer. */
export interface Alternative {
  available: boolean;
  note: string;
  intent?: TransferIntent;
  tier?: Tier;
}

export interface Verdict {
  tier: Tier;
  reasons: string[];
  explanation?: string;
  alternative?: Alternative;
}

export interface BatchLine {
  line: number;
  tier: Tier;
  reasons: string[];
}

export interface Status {
  address: string | null;
  chain: string;
  chainId: number;
  explorer: string | null;
  paused: boolean;
  vault: string | null;
  policyHash: string | null;
  llm: boolean;
  model: string | null;
  policyIntegrity?: { hash: string | null; drift: boolean; pinned: boolean; matchesPin: boolean | null };
  pendingTxs?: number;
  scheduler?: { enabled: boolean; intervalSec: number; lastRunAt: string | null; lastError: string | null } | null;
  /** True when X402_API_URL is configured, so the paid-API card can be shown. */
  x402?: boolean;
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
  totpEnabled?: boolean;
}

export type Tier = 'T1_AUTO' | 'T2_CONFIRM' | 'T3_DENY';

export type TransferIntent =
  | { kind: 'native_transfer'; to: string; amount: string }
  | { kind: 'erc20_transfer'; token: string; to: string; amount: string };

/** Transfers plus the one approval intent the UI may submit directly. */
export type ActionIntent =
  | TransferIntent
  | { kind: 'erc20_approve'; token: string; spender: string; amount: string | 'unlimited' };

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
/** Thrown when the account has 2FA and the login needs the authenticator code. */
export class TotpRequiredError extends Error {}

export async function login(username: string, password: string, code?: string): Promise<Me> {
  const r = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username, password, ...(code ? { code } : {}) }),
  });
  const data = (await r.json()) as Me & { error?: string; totp?: boolean };
  if (r.status === 401 && data.totp) throw new TotpRequiredError(data.error ?? 'Enter your authenticator code.');
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

export const getTotpStatus = () => read<{ enabled: boolean }>('/api/auth/totp');
export const setupTotp = () => post<{ secret: string; uri: string }>('/api/auth/totp/setup', {});
export const enableTotp = (code: string) => post<{ enabled: boolean }>('/api/auth/totp/enable', { code });
export const disableTotp = (password: string) => post<{ enabled: boolean }>('/api/auth/totp/disable', { password });
export const revokeOtherSessions = () => post<{ revoked: number }>('/api/auth/sessions/revoke', {});
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
export const getPending = () => read<{ pending: string | null; expiresAt: number | null; id: string | null }>('/api/pending');
/** `id` names the exact request being answered, so a stale click can never approve a newer one. */
export const decide = (approved: boolean, id: string) => post<{ decided: boolean }>('/api/decide', { approved, id });
export const getHealth = () => api<Health>('/api/health');
export const getTxStatus = (hash: string) => read<TxStatus>(`/api/tx?hash=${encodeURIComponent(hash)}`);
export const getPendingTxs = () => read<{ pending: { hash: string; sentAt: string }[] }>('/api/tx/pending');
export interface BatchTransfer {
  to: string;
  amount: string;
  token?: string;
}
export const previewBatch = (transfers: BatchTransfer[]) =>
  post<{ lines: BatchLine[]; allowed: boolean }>('/api/batch/preview', { transfers });
export const sendBatch = (transfers: BatchTransfer[]) =>
  post<{ lines: BatchLine[]; results: TransactResult[]; stoppedAtLine?: number }>('/api/batch', { transfers });
export const addContact = (label: string, address: string) =>
  post<{ policyHash: string; contacts: Record<string, string> }>('/api/policy/contacts/add', { label, address });
export const removeContact = (label: string) =>
  post<{ policyHash: string; contacts: Record<string, string> }>('/api/policy/contacts/remove', { label });
export const pause = () => post<{ paused: boolean }>('/api/pause', {});
export const preview = (intent: ActionIntent) => post<Verdict>('/api/preview', { intent });
export const transact = (intent: ActionIntent) => post<TransactResult>('/api/transact', { intent });
export const chat = (message: string, session?: string) =>
  post<{ session: string; answer: string; events?: string[] }>('/api/chat', { message, session });

/** Recipient lists after an edit, plus the new policy fingerprint. */
export interface RecipientLists {
  policyHash: string;
  allowlist: Record<string, string>;
  denylist: string[];
}
// Adding a known recipient and un-denying one lower the tier an address gets, so
// the server asks for the owner's password again on those two calls.
export const addRecipient = (label: string, address: string, password: string) =>
  post<RecipientLists>('/api/policy/recipients/add', { label, address, password });
export const removeRecipient = (label: string) => post<RecipientLists>('/api/policy/recipients/remove', { label });
export const addDenied = (address: string) => post<RecipientLists>('/api/policy/deny/add', { address });
export const removeDenied = (address: string, password: string) => post<RecipientLists>('/api/policy/deny/remove', { address, password });

// --- Features that used to be CLI-only -------------------------------------

/** Release the kill switch. Owner-only, password-confirmed. */
export const resume = (password: string) => post<{ paused: boolean }>('/api/resume', { password });

/** Rotate the signing key into the env file; takes effect on restart. */
export const generateWallet = (password: string) =>
  post<{ address: string; previous: string | null; restartRequired: boolean; note: string }>('/api/wallet/generate', {
    password,
    confirm: 'new-wallet',
  });

export interface ScheduleRule {
  id: string;
  enabled: boolean;
  trigger: { kind: 'weekly'; weekday: number; atTimeUtc: string } | { kind: 'price-drop'; asset: string; dropPct: string; baselineUsd: string };
  action: {
    kind: 'native_transfer' | 'erc20_transfer' | 'swap';
    token?: string;
    to?: string;
    tokenIn?: string;
    tokenOut?: string;
    slippageBps?: number;
    amount?: string;
    amountPct?: string;
  };
}
export interface ScheduleRun {
  ruleId: string;
  status: string;
  txHash?: string;
  error?: string;
}
export interface ScheduleLastRun {
  ruleId: string;
  ts: string;
  status?: string;
  txHash?: string;
  error?: string;
}
export interface SchedulesView {
  version: number;
  rules: ScheduleRule[];
  scheduler: { enabled: boolean; intervalSec: number; lastRunAt: string | null; lastError: string | null } | null;
  lastRuns: ScheduleLastRun[];
}
export const getSchedules = () => read<SchedulesView>('/api/schedules');
export const runSchedules = (dryRun: boolean) => post<{ ran: number; results: ScheduleRun[] }>('/api/schedules/run', { dryRun });

export interface WhatIfResult {
  baseline: { tier: Tier; reasons: string[] };
  hypothetical: { tier: Tier; reasons: string[] };
  morePermissive: boolean;
  summary: string;
}
export interface WhatIfRequest {
  to: string;
  amount: string;
  token?: string;
  allow?: boolean;
  paused?: boolean;
  limits?: { autoMaxPerTx?: string; hardMaxPerTx?: string; dailyBudget?: string };
}
export const whatIf = (body: WhatIfRequest) => post<WhatIfResult>('/api/whatif', body);

export interface SwapRequest {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippageBps?: number;
}
export interface SwapQuote {
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  amountOut?: string;
  minAmountOut?: string;
  slippageBps?: number;
  router?: string;
  note?: string;
  error?: string;
}
export interface SwapStep {
  step: string;
  status?: string;
  tier?: Tier;
  txHash?: string;
  explorerUrl?: string;
  reason?: string;
  error?: string;
}
export const swapQuote = (body: SwapRequest) => post<SwapQuote>('/api/swap/quote', body);
export const executeSwap = (body: SwapRequest) => post<{ steps?: SwapStep[]; error?: string }>('/api/swap', body);

/** Fetch a paid API resource; the wallet pays if the endpoint answers 402. */
export const fetchPaid = (url?: string) => post<unknown>('/api/x402', url ? { url } : {});

export interface AnchorCheck {
  txHash: string;
  ok: boolean;
  seq?: number;
  reason: string;
}
export interface AnchorReport {
  local: { ok: boolean; brokenAt?: number; reason?: string };
  onchain: { ok: boolean; checks: AnchorCheck[] };
  note?: string;
}
export const anchorAudit = () =>
  post<{ status: string; anchoredSeq: number; headHash: string; txHash?: string; explorerUrl?: string; error?: string; reasons: string[] }>(
    '/api/audit/anchor',
    {},
  );
export const getAnchors = () => read<AnchorReport>('/api/audit/anchors');
