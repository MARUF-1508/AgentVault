import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getMe, login as apiLogin, logout as apiLogout, type Me, type Permission } from './api';

interface AuthValue {
  me: Me | null;
  /** True until the first /api/auth/me answer arrives. */
  loading: boolean;
  can: (p: Permission) => boolean;
  login: (username: string, password: string, code?: string) => Promise<Me>;
  logout: () => Promise<void>;
  /** Re-reads the session from the server (used right after first-run setup). */
  refresh: () => Promise<Me | null>;
}

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Mirrors the server session for the UI. Hiding a button is convenience only:
 * the server checks the role on every request.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
    const expired = () => setMe(null);
    window.addEventListener('av:unauthorized', expired);
    return () => window.removeEventListener('av:unauthorized', expired);
  }, []);

  const login = useCallback(async (username: string, password: string, code?: string) => {
    const user = await apiLogin(username, password, code);
    setMe(user);
    return user;
  }, []);

  const logout = useCallback(async () => {
    await apiLogout().catch(() => {});
    setMe(null);
  }, []);

  const refresh = useCallback(async () => {
    const next = await getMe().catch(() => null);
    setMe(next);
    return next;
  }, []);

  const can = useCallback((p: Permission) => Boolean(me?.permissions.includes(p)), [me]);

  return <AuthContext.Provider value={{ me, loading, can, login, logout, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
