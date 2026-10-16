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
  recipients: { allowlist: Record<string, string> };
}

export interface ActivityEntry {
  seq: number;
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init });
  const data = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

export const getPortfolio = () => api<Portfolio>('/api/portfolio');
export const getPolicy = () => api<Policy>('/api/policy');
export const getActivity = (limit = 20) => api<ActivityEntry[]>(`/api/activity?limit=${limit}`);
export const getVerify = () => api<{ ok: boolean; brokenAt?: number; reason?: string }>('/api/verify');
export const getPending = () => api<{ pending: string | null }>('/api/pending');
export const decide = (approved: boolean) =>
  api<{ decided: boolean }>('/api/decide', { method: 'POST', body: JSON.stringify({ approved }) });
export const chat = (message: string, session?: string) =>
  api<{ session: string; answer: string }>('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ message, session }),
  });
