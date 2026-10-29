import { Suspense } from 'react';
import { AppProvider, useApp, type View } from './lib/app';
import { api } from './lib/api';
import { askConfirm, toast } from './lib/bus';
import { cx, DialogHost, Skeleton, ToastHost } from './components/ui';
import { Dashboard } from './views/Dashboard';
import { Jobs } from './views/Jobs';
import { Studio } from './views/Studio';
import { Applications } from './views/Applications';
import { SearchSettings } from './views/SearchSettings';
import { ProfileView } from './views/Profile';
import { Documents } from './views/Documents';
import { Settings } from './views/Settings';
import { Notifications } from './views/Notifications';

const NAV: [View, string][] = [['dashboard', 'Home'], ['profile', 'My profile'], ['jobs', 'Jobs'], ['studio', 'My CVs'], ['applications', 'My applications'], ['searchsettings', 'Job preferences'], ['settings', 'Settings']];
const VIEWS: Record<View, () => JSX.Element> = { dashboard: Dashboard, jobs: Jobs, studio: Studio, applications: Applications, searchsettings: SearchSettings, profile: ProfileView, documents: Documents, settings: Settings, notifications: Notifications };

export async function switchMode(mode: 'demo' | 'production', app: ReturnType<typeof useApp>) {
  const demo = mode === 'demo';
  const ok = await askConfirm(demo
    ? { title: 'Switch to demo mode?', body: 'You will see clearly labelled sample jobs only. Your real data is kept but hidden, and searching and reminders pause until you switch back.', confirmLabel: 'Switch to demo mode' }
    : { title: 'Leave demo mode?', body: 'The sample jobs, and anything you created on them (applications, CV versions), will be deleted. Your real data comes back.', confirmLabel: 'Switch to production', danger: true });
  if (!ok) return;
  try { await api('/api/app-mode', { method: 'PUT', body: { mode } }); await app.refreshStatus(); app.setSelected(null); toast(demo ? 'Demo mode on' : 'Production mode'); app.go('dashboard'); } catch (e) { toast((e as Error).message, true); }
}

function Shell() {
  const app = useApp();
  const { view, status, nonce, unread } = app;
  const demo = status.mode === 'demo';
  const Current = VIEWS[view];
  return <>
    <a href="#view" onClick={(e) => { e.preventDefault(); document.getElementById('view')?.focus(); }}
      className="skip absolute left-2 top-[-60px] z-30 rounded-lg bg-accent px-3.5 py-2 text-accent-ink no-underline focus:top-2">Skip to main content</a>
    <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-card px-5 py-2.5 max-sm:px-3 max-sm:py-2">
      <div id="demoBanner" hidden={!demo} role="status" className="[&[hidden]]:hidden order-first -mx-5 -mt-2.5 mb-0.5 basis-full bg-[repeating-linear-gradient(45deg,#7a4b00,#7a4b00_12px,#8a5700_12px,#8a5700_24px)] px-5 py-[7px] text-center text-white max-sm:-mx-3 max-sm:-mt-2 max-sm:px-3 max-sm:py-1.5 max-sm:text-[13px]">
        <strong>DEMO MODE</strong> Sample data only: these are not real jobs and nothing here can be applied to.{' '}
        <button id="exitDemo" type="button" className="ml-2 rounded-lg border border-line bg-card px-2.5 py-0.5 text-[13px] text-ink max-[420px]:mx-auto max-[420px]:mt-1.5 max-[420px]:block" onClick={() => switchMode('production', app)}>Exit demo mode</button>
      </div>
      <h1 className="m-0 whitespace-nowrap text-lg font-bold max-[420px]:text-[15px] max-sm:text-base">Saudi Job Finder</h1>
      <nav id="nav" aria-label="Main" className="flex flex-1 flex-wrap gap-1 max-sm:order-3 max-sm:basis-full">
        {NAV.map(([v, label]) => <button key={v} type="button" data-view={v} aria-current={view === v ? 'page' : undefined} onClick={() => app.go(v)}
          className={cx('min-h-9 whitespace-nowrap rounded-lg px-3 py-1.5 hover:bg-goodbg max-sm:flex-auto max-sm:px-2.5 max-sm:text-sm', view === v ? 'active bg-goodbg font-semibold text-accent' : 'text-ink')}>{label}</button>)}
      </nav>
      <button id="bell" type="button" aria-label="Notifications" onClick={() => app.go('notifications')}
        className={cx('rounded-full border px-2.5 py-1', unread ? 'border-warn font-bold text-warn' : 'border-line')}>{unread ? `🔔 ${unread}` : '🔔'}</button>
      <span id="aiBadge" className={cx('rounded-full px-2.5 py-0.5 text-xs', status.ai ? 'bg-goodbg text-good' : 'bg-warnbg text-warn')}>{status.ai ? 'AI on' : 'AI off (no API key)'}</span>
    </header>
    <ToastHost />
    <main id="view" tabIndex={-1} aria-label="Main content" className="mx-auto max-w-[1400px] p-5 focus:outline-none max-md:p-4 max-sm:p-3">
      <Suspense fallback={<Skeleton />}><Current key={`${view}-${nonce}`} /></Suspense>
    </main>
    <DialogHost />
  </>;
}

export default function App() { return <AppProvider><Shell /></AppProvider>; }
