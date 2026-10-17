import { Bot, LayoutDashboard, ScrollText, Send, Settings, ShieldCheck } from 'lucide-react';

export const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/agent', label: 'Agent', icon: Bot },
  { to: '/transfer', label: 'Transfer', icon: Send },
  { to: '/activity', label: 'Activity', icon: ScrollText },
  { to: '/security', label: 'Security', icon: ShieldCheck },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;
