import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { toast } from './bus';
import type { AppStatus, Meta, Profile, Rec } from './types';

export type View = 'dashboard' | 'jobs' | 'studio' | 'applications' | 'searchsettings' | 'profile' | 'documents' | 'settings' | 'notifications';

export interface JobFilters { fit?: boolean; [k: string]: string | boolean | undefined }
export interface TrackerPrefs { mode: 'board' | 'table'; q: string; status: string; employer: string; city: string; sort: string; dir: string; followup: boolean }
export const DEFAULT_TRACKER: TrackerPrefs = { mode: 'board', q: '', status: '', employer: '', city: '', sort: 'updated_at', dir: 'desc', followup: false };

interface Ctx {
  meta: Meta; status: AppStatus; privacy: Rec; profile: Profile;
  setProfile: (p: Profile) => void; refreshStatus: () => Promise<void>; refreshPrivacy: () => Promise<void>;
  view: View; go: (v: View) => void; nonce: number; reload: () => void;
  selected: number | null; setSelected: (id: number | null) => void; openJob: (id: number) => void;
  filters: JobFilters; setFilters: (f: JobFilters) => void;
  tracker: TrackerPrefs; setTracker: (t: Partial<TrackerPrefs>) => void;
  unread: number; refreshBell: () => void;
}
const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => { const c = useContext(AppCtx); if (!c) throw new Error('useApp outside provider'); return c; };

// "Only show jobs that fit me" is never remembered: showing weak matches is a one-time look, not a setting that sticks.
const loadFilters = (): JobFilters => { try { const { fit: _fit, ...rest } = JSON.parse(localStorage.getItem('filters') || '{}') || {}; return rest; } catch { return {}; } };
const saveFilters = (f: JobFilters) => { try { const { fit: _fit, ...rest } = f; localStorage.setItem('filters', JSON.stringify(rest)); } catch { /* storage unavailable */ } };

export function AppProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<{ meta: Meta; status: AppStatus; privacy: Rec; profile: Profile } | null>(null);
  const [bootErr, setBootErr] = useState<Error | null>(null);
  const [view, setView] = useState<View>('dashboard');
  const [nonce, setNonce] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [filters, setFiltersState] = useState<JobFilters>(loadFilters);
  const [tracker, setTrackerState] = useState<TrackerPrefs>(DEFAULT_TRACKER);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    Promise.all([api<Meta>('/api/meta'), api<AppStatus>('/api/status'), api<Rec>('/api/privacy'), api<Profile>('/api/profile')])
      .then(([meta, status, privacy, profile]) => setBoot({ meta, status, privacy, profile }))
      .catch((e: Error) => { setBootErr(e); toast(e.message, true); });
  }, []);

  const refreshBell = useCallback(() => { api<{ unread: number }>('/api/notifications?limit=1').then((n) => setUnread(n.unread)).catch(() => {}); }, []);
  const bellTimer = useRef<ReturnType<typeof setInterval>>();
  useEffect(() => { if (!boot) return; refreshBell(); bellTimer.current = setInterval(refreshBell, 60000); return () => clearInterval(bellTimer.current); }, [boot, refreshBell]);

  if (bootErr) return <div className="p-6 text-bad" role="alert">Could not start: {bootErr.message}</div>;
  if (!boot) return null;

  const patch = (k: 'status' | 'privacy' | 'profile', v: unknown) => setBoot((b) => (b ? { ...b, [k]: v } : b));
  const value: Ctx = {
    ...boot,
    setProfile: (p) => patch('profile', p),
    refreshStatus: async () => patch('status', await api<AppStatus>('/api/status')),
    refreshPrivacy: async () => patch('privacy', await api('/api/privacy')),
    view, nonce, reload: () => setNonce((n) => n + 1),
    go: (v) => { setView(v); setNonce((n) => n + 1); window.scrollTo({ top: 0 }); },
    selected, setSelected,
    openJob: (id) => { setSelected(id); setView('jobs'); setNonce((n) => n + 1); },
    filters, setFilters: (f) => { setFiltersState(f); saveFilters(f); },
    tracker, setTracker: (t) => setTrackerState((p) => ({ ...p, ...t })),
    unread, refreshBell,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

/** Loads data for a view. The result is dropped if the view was left or re-run meanwhile, so a slow response can't overwrite a newer screen. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const run = useRef(0);
  const fnRef = useRef(fn); fnRef.current = fn;
  useEffect(() => {
    const id = ++run.current;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fnRef.current().then((data) => { if (id === run.current) setState({ data, loading: false }); }, (error: Error) => { if (id === run.current) setState({ error, loading: false }); });
    return () => { run.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  return { ...state, reload: () => setTick((t) => t + 1), setData: (data: T) => setState({ data, loading: false }) };
}
