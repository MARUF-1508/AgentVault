import { createContext, useContext, useState, type ReactNode } from 'react';
import { getBudget, getHealth, getPolicy, getStatus, type Budget, type Health, type Policy, type Status } from './api';
import { usePoll } from './format';

interface WalletData {
  status: Status | null;
  statusError: string;
  budget: Budget | null;
  policy: Policy | null;
  /** Chain/RPC reachability from /api/health, for the network indicator. */
  health: Health | null;
  healthError: string;
  /** Bumps after any action so every page refetches at once. */
  refreshKey: number;
  refresh: () => void;
}

const DataContext = createContext<WalletData | null>(null);

/** Status, budget, policy and network health, polled once and shared by every page. */
export function WalletDataProvider({ children }: { children: ReactNode }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [status, statusError] = usePoll(getStatus, 5_000, [refreshKey]);
  const [budget] = usePoll(getBudget, 10_000, [refreshKey]);
  // Also keyed on refreshKey: recipient-list edits must show up immediately,
  // not after the next 60-second poll.
  const [policy] = usePoll(getPolicy, 60_000, [refreshKey]);
  const [health, healthError] = usePoll(getHealth, 15_000, [refreshKey]);
  return (
    <DataContext.Provider
      value={{ status, statusError, budget, policy, health, healthError, refreshKey, refresh: () => setRefreshKey((k) => k + 1) }}
    >
      {children}
    </DataContext.Provider>
  );
}

export function useWallet(): WalletData {
  const v = useContext(DataContext);
  if (!v) throw new Error('useWallet outside WalletDataProvider');
  return v;
}
