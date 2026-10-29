import { askConfirm, toast } from './bus';
import type { Rec } from './types';

export class ApiError extends Error {
  status?: number; duplicates?: unknown;
  constructor(message: string, status?: number, duplicates?: unknown) { super(message); this.status = status; this.duplicates = duplicates; }
}
interface Opts { method?: string; body?: unknown; retried?: boolean }

/** JSON API call. First use of an AI feature shows exactly what is sent and where, and only continues with consent. */
export async function api<T = Rec>(path: string, opts: Opts = {}): Promise<T> {
  const init: RequestInit = { method: opts.method || 'GET', headers: {} };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) { (init.headers as Record<string, string>)['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const res = await fetch(path, init);
  if (res.status === 204) return null as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403 && data.code === 'consent_required' && !opts.retried) {
      if (!(await askConfirm({ title: 'Allow AI processing?', body: data.disclosure, confirmLabel: 'Allow and continue' }))) throw new ApiError('Cancelled. Nothing was sent to the AI provider.');
      await api('/api/privacy/consent', { method: 'POST', body: { ai: true } });
      return api<T>(path, { ...opts, retried: true });
    }
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.duplicates);
  }
  return data as T;
}

/** Runs an action, reporting failures as a toast instead of throwing. Resolves undefined on failure. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch (e) { toast((e as Error).message, true); return undefined; }
}

/** Fetch → blob so server errors (e.g. "PDF can't contain Arabic") show as a message instead of navigating away. */
export async function downloadFile(url: string) {
  const res = await fetch(url);
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Download failed'); }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'download';
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
export const csv = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString() : '');
export const fmtWhen = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

export const LABEL: Record<string, string> = { full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', internship: 'Internship', unknown: 'Unspecified', remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', entry: 'Entry', mid: 'Mid', senior: 'Senior', lead: 'Lead' };
export const SPONSOR: Record<string, string> = { yes: 'Sponsorship: stated', no: 'Sponsorship: not offered', not_specified: 'Sponsorship: Not specified' };
export const RELOC: Record<string, string> = { yes: 'Relocation: stated', no: 'Relocation: not offered', not_specified: 'Relocation: Not specified' };
