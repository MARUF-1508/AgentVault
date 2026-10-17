import { WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * A thin banner when the browser loses its connection. The wallet server is
 * local, so "offline" mostly means the RPC endpoints are unreachable too —
 * better to say so than to let buttons fail silently.
 */
export default function OfflineBanner() {
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);

  useEffect(() => {
    const down = () => setOffline(true);
    const up = () => setOffline(false);
    window.addEventListener('offline', down);
    window.addEventListener('online', up);
    return () => {
      window.removeEventListener('offline', down);
      window.removeEventListener('online', up);
    };
  }, []);

  if (!offline) return null;
  return (
    <p className="banner warn" role="status">
      <WifiOff size={14} aria-hidden /> You are offline. Actions will fail until the connection returns; nothing is queued or sent silently.
    </p>
  );
}
