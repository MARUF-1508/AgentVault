import { MotionConfig } from 'framer-motion';
import type { ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from './auth';
import { WalletDataProvider } from './data';
import { usePageTitle } from './format';
import AppShell from './layout/AppShell';
import Activity from './pages/Activity';
import Agent from './pages/Agent';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import Security from './pages/Security';
import Settings from './pages/Settings';
import Transfer from './pages/Transfer';
import { ThemeProvider, useTheme } from './theme';
import './styles.css';

/** Pages behind sign-in. The data provider only starts polling once signed in. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="splash" aria-busy="true">
        <img src="/favicon.png" alt="" width={48} height={48} />
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <WalletDataProvider>{children}</WalletDataProvider>;
}

function NotFound() {
  usePageTitle('Not found');
  return (
    <div className="page-head">
      <div>
        <h1>Page not found</h1>
        <p className="muted">
          <Link to="/">Back to the dashboard</Link>
        </p>
      </div>
    </div>
  );
}

function ThemedToaster() {
  const { resolved } = useTheme();
  return <Toaster theme={resolved} position="top-right" richColors closeButton />;
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route
                element={
                  <RequireAuth>
                    <AppShell />
                  </RequireAuth>
                }
              >
                <Route index element={<Dashboard />} />
                <Route path="agent" element={<Agent />} />
                <Route path="transfer" element={<Transfer />} />
                <Route path="activity" element={<Activity />} />
                <Route path="security" element={<Security />} />
                <Route path="settings" element={<Settings />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
          <ThemedToaster />
        </AuthProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}
