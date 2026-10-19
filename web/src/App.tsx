import { MotionConfig } from 'framer-motion';
import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from './auth';
import ErrorBoundary from './components/ErrorBoundary';
import { WalletDataProvider } from './data';
import { usePageTitle } from './format';
import AppShell from './layout/AppShell';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';

// Secondary pages load on first visit, which keeps the first paint small.
const Activity = lazy(() => import('./pages/Activity'));
const Agent = lazy(() => import('./pages/Agent'));
const Security = lazy(() => import('./pages/Security'));
const Settings = lazy(() => import('./pages/Settings'));
const Transfer = lazy(() => import('./pages/Transfer'));

/** Loading state while a page's code arrives; announced politely to screen readers. */
function PageLoading() {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <span className="skeleton-line" />
      <span className="skeleton-line short" />
      <span className="sr-only">Loading the page…</span>
    </div>
  );
}

const page = (el: ReactNode) => <Suspense fallback={<PageLoading />}>{el}</Suspense>;
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
            <ErrorBoundary>
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
                  <Route path="agent" element={page(<Agent />)} />
                  <Route path="transfer" element={page(<Transfer />)} />
                  <Route path="activity" element={page(<Activity />)} />
                  <Route path="security" element={page(<Security />)} />
                  <Route path="settings" element={page(<Settings />)} />
                  <Route path="*" element={<NotFound />} />
                </Route>
              </Routes>
            </ErrorBoundary>
          </BrowserRouter>
          <ThemedToaster />
        </AuthProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}
