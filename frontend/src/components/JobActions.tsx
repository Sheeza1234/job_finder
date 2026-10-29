import { useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/bus';
import { useApp } from '../lib/app';
import { uiFor } from '../lib/jobui';
import { Btn, Row } from './ui';

/** Shared per-job actions: Open / Check my fit / Make my CV / Save. None of these submit anything. */
export function JobActions({ job }: { job: { id: number; app_status?: string | null } }) {
  const app = useApp();
  const [saved, setSaved] = useState(false);
  const open = () => app.openJob(job.id);
  return <Row onClick={(e) => e.stopPropagation()} className="mt-auto pt-2.5 [&>button]:px-2.5 [&>button]:py-1 [&>button]:text-[13px]">
    <Btn onClick={open}>Open</Btn>
    <Btn busyLabel="Checking…" onAction={async () => { await api(`/api/jobs/${job.id}/analyze`, { method: 'POST' }); toast('Analysis ready'); open(); }}>Check my fit</Btn>
    <Btn busyLabel="Tailoring…" onAction={async () => {
      const v = await api(`/api/jobs/${job.id}/tailor`, { method: 'POST' });
      Object.assign(uiFor(job.id), { cvId: v.id, cvTab: 'preview' }); toast('Your CV for this job is ready. Please read it before using it.'); open();
    }}>Make my CV for this job</Btn>
    <Btn disabled={!!job.app_status || saved} busyLabel="Saving…" onAction={async () => { await api('/api/applications', { method: 'POST', body: { job_id: job.id } }); toast('Saved. You can find it under My applications.'); setSaved(true); }}>
      {job.app_status || saved ? 'Saved ✓' : 'Save'}</Btn>
  </Row>;
}
