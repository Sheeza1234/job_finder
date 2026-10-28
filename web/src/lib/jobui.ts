// Per-job UI memory that should survive a reload of the job panel (selected CV version, tab, assistant session).
import type { Rec } from './types';

export interface JobUi { cvTab: 'preview' | 'edit' | 'compare' | 'why'; mode: 'A' | 'B' | 'C'; cvId?: number | null; letterId?: number | null; cmp?: string; session?: Rec | null }
const state: Record<number, JobUi> = {};
export const uiFor = (jobId: number): JobUi => (state[jobId] ||= { cvTab: 'preview', mode: 'A' });
